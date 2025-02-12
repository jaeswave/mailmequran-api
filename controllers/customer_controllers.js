const { generateOtp, comparePassword, generateJwtToken } = require("../utils");
const {
  createCustomerValidation,
  verifyEmailAndOtpValidation,
  resendOtpValidation,
  loginValidation,
  updateCustomerValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  preferenceValidation,
  updatePreferenceValidation,
} = require("../validations");
const { v4: uuidv4 } = require("uuid");
const { hashPassword } = require("../utils");
const { TemporaryCustomers } = require("../models/temporary_customers");
const { Otp } = require("../models/otp_model");
const { Customers } = require("../models/customer_model");
const { Preferences } = require("../models/preference_model");
const { Email_logs } = require("../models/emailLogs_model");
const { Bookmark } = require("../models/bookmark_model");
const sequelize = require("../config/db");
const messages = require("../constants/messages");
const statusCode = require("../constants/statusCode");
const { sendEmail } = require("../services/email");
const jwtExpiringTime = "1h";
const cron = require("node-cron");
const moment = require("moment");
const { Op } = require("sequelize");
const { Frequency } = require("../enum");
const {
  formatOtpMessage,
  formatVerificationMessage,
  formatPasswordResetMessage,
  formatPasswordResetSuccessMessage,
  formatQuranEmailTemplate,
  fetchLogsAndPreferences,
  calculateNextSendingDate,
} = require("../utils");
const { getTotalVersesInSurah } = require("../utils");
const { getVerses, generateRandomVerse } = require("../api/quran");
const { initializePayment, verifyPayment } = require("../services/donate");
const today = moment().format("YYYY-MM-DD");
const currentTime = moment().format("HH:mm");
const now = moment().format("YYYY-MM-DD");
const currentHour = moment().hour();

const createCustomer = async (request, response, next) => {
  try {
    const { surname, othernames, email, password, phone } = request.body;
    const { error } = createCustomerValidation(request.body);
    if (error !== undefined) {
      throw new Error(
        error.details[0].message || messages.SOMETHING_WENT_WRONG
      );
    }

    const [customerExistence, tempCustomerExistence] = await Promise.all([
      Customers.findOne({ where: { email } }),
      TemporaryCustomers.findOne({ where: { email } }),
    ]);

    if (customerExistence != null) {
      const errorData = new Error();
      errorData.message =
        "An account with this email has already been created please login your credentials";
      errorData.isVerify = messages.CUSTOMER_CODE_EXIST;
      throw errorData;
    }
    if (tempCustomerExistence != null) {
      const errorData = new Error();
      errorData.message =
        "An account with this email has already been created please verify with otp";
      errorData.isVerify = messages.CUSTOMER_CODE_VERIFY;
      throw errorData;
    }

    const [hash, salt] = await hashPassword(password);
    await TemporaryCustomers.create({
      customer_id: uuidv4(),
      surname: surname,
      othernames: othernames,
      email: email,
      password_hash: hash,
      password_salt: salt,
      phone: phone,
    });
    const { otp, expiresAt } = generateOtp();
    await Otp.create({
      email: email,
      otp_code: otp,
      expires_at: expiresAt,
    });

    const message = formatOtpMessage(otp);
    sendEmail(email, message, "MAIL ME QURAN Email Verification");

    response.status(statusCode.CREATED).json({
      status: "success",
      message: messages.OTP_SENT,
    });
  } catch (error) {
    next(error);
  }
};

const verifyEmail = async (request, response, next) => {
  const transaction = await sequelize.transaction();
  console.log("Transaction started");
  try {
    const { email, otp } = request.params;
    const { error } = verifyEmailAndOtpValidation(request.params);
    if (error !== undefined) {
      throw new Error(
        error.details[0].message || messages.SOMETHING_WENT_WRONG
      );
    }
    const checkIfEmailAndOtpExist = await Otp.findOne({
      where: { email: email, otp_code: otp },
    });

    if (checkIfEmailAndOtpExist == null) {
      throw new Error(messages.OTP_INVALID_OR_EXPIRED);
    }

    const currentTime = new Date();
    const { expires_at } = checkIfEmailAndOtpExist.dataValues;
    if (currentTime > new Date(expires_at)) {
      throw new Error(messages.OTP_INVALID_OR_EXPIRED);
    }

    const tempCustomer = await TemporaryCustomers.findOne({
      where: { email: email },
    });
    if (tempCustomer == null) {
      throw new Error("The verification process failed. Please try again");
    }

    await Customers.create(
      {
        customer_id: tempCustomer.customer_id,
        surname: tempCustomer.surname,
        othernames: tempCustomer.othernames,
        email: tempCustomer.email,
        phone: tempCustomer.phone,
        is_email_verified: true,
        password_hash: tempCustomer.password_hash,
        password_salt: tempCustomer.password_salt,
        created_at: tempCustomer.created_at,
      },
      { transaction }
    );

    await Otp.destroy({ where: { email }, transaction });
    await tempCustomer.destroy({ transaction });

    await transaction.commit();

    //send email
    const message = formatVerificationMessage();
    sendEmail(email, message, "MAIL ME QURAN Email Verification Successful");

    response.status(statusCode.OK).json({
      status: "success",
      message: messages.CUSTOMER_CREATED,
    });
  } catch (error) {
    await transaction.rollback();
    next(error);
  }
};

// Resend OTP route
const resendOtp = async (request, response, next) => {
  try {
    const { email } = request.params;
    const { error } = resendOtpValidation(request.params);
    const checkIfEmailAndOtpExist = await Otp.findOne({ where: { email } });
    if (checkIfEmailAndOtpExist == null) {
      throw new Error("This process failed. Please try again");
    }

    const currentTime = new Date();
    const { expires_at } = checkIfEmailAndOtpExist.dataValues;
    if (currentTime < new Date(expires_at)) {
      throw new Error("your OTP has not expired");
    }

    const newOtp = checkIfEmailAndOtpExist.dataValues.otp_code;
    const { expiresAt } = generateOtp();

    await Otp.update({ expires_at: expiresAt }, { where: { email } });

    //send email
    const message = formatOtpMessage(newOtp);
    sendEmail(email, message, "MAIL ME QURAN Email Verification");

    response.status(statusCode.OK).json({
      message: "New OTP generated and sent successfully.",
      status: "success",
    });
  } catch (error) {
    next(error);
  }
};

const login = async (request, response, next) => {
  try {
    const { email, password } = request.body;
    const { error } = loginValidation(request.body);
    if (error !== undefined) {
      throw new Error(
        error.details[0].message || messages.SOMETHING_WENT_WRONG
      );
    }

    const customer = await Customers.findOne({ where: { email } });
    if (customer == null) throw new Error(messages.INVALID_CREDENTIALS);

    const match = await comparePassword(
      password,
      customer.dataValues.password_hash
    );

    if (!match) throw new Error(messages.INVALID_CREDENTIALS);

    const token = await generateJwtToken(email, jwtExpiringTime);

    response.header("access_token", token);
    response.status(statusCode.OK).json({
      status: "success",
      message: messages.LOGIN_SUCCESS,
    });
  } catch (error) {
    next(error);
  }
};

const updateCustomer = async (request, response, next) => {
  try {
    const { customer_id } = request.params;
    const data = request.body;
    if (!data || Object.keys(data).length === 0) {
      throw new Error("invalid data");
    }
    const { error } = updateCustomerValidation(data);
    if (error !== undefined) {
      throw new Error(
        error.details[0].message || messages.SOMETHING_WENT_WRONG
      );
    }

    await Customers.update(data, {
      where: {
        customer_id: customer_id,
      },
    });

    response.status(statusCode.OK).json({
      status: "success",
      message: messages.CUSTOMER_UPDATED,
    });
  } catch (error) {
    next(error);
  }
};

const getCustomer = async (request, response, next) => {
  try {
    const { customer_id } = request.params; // retrieve customer_id from the middleware

    const customer = await Customers.findOne({
      where: { customer_id: customer_id },
      attributes: ["surname", "othernames", "email"],
    });

    response.status(statusCode.OK).json({
      status: "success",
      message: messages.CUSTOMER_FOUND,
      data: customer,
    });
  } catch (error) {
    next(error);
  }
};

const startForgetPassword = async (request, response, next) => {
  try {
    const { email } = request.params;

    const { error } = forgotPasswordValidation(request.params);
    if (error !== undefined) {
      throw new Error(
        error.details[0].message || messages.SOMETHING_WENT_WRONG
      );
    }

    const { otp, expiresAt } = generateOtp();
    await Otp.create({ email, otp_code: otp, expires_at: expiresAt });

    //send email
    const message = formatPasswordResetMessage(otp);
    sendEmail(email, message, "Password Reset");

    response.status(statusCode.OK).json({
      status: "success",
      message:
        "Forget Password request sent successfully, check your email for OTP",
    });
  } catch (error) {
    next(error);
  }
};

const completeForgetPassword = async (request, response, next) => {
  try {
    const { email, otp, newPassword } = request.body;
    const { error } = resetPasswordValidation(request.body);
    if (error !== undefined) {
      throw new Error(
        error.details[0].message || messages.SOMETHING_WENT_WRONG
      );
    }

    // Check if email exists in customer table to abort early
    const customer = await Customers.findOne({ where: { email } });
    if (customer == null)
      throw new Error("No record found for this credentials provided");

    const checkIfEmailAndOtpExist = await Otp.findOne({
      where: { email: email, otp_code: otp },
    });

    if (checkIfEmailAndOtpExist == null) {
      throw new Error(messages.OTP_INVALID_OR_EXPIRED);
    }
    const currentTime = new Date();
    const { expires_at } = checkIfEmailAndOtpExist.dataValues;

    if (currentTime > new Date(expires_at)) {
      throw new Error(messages.OTP_INVALID_OR_EXPIRED);
    }

    const [hash, salt] = await hashPassword(newPassword);
    await Customers.update(
      { password_hash: hash, password_salt: salt },
      { where: { email } }
    );
    await Otp.destroy({ where: { email, otp_code: otp } });

    //send email
    const message = formatPasswordResetSuccessMessage();

    sendEmail(email, message, "Password Reset Successful");

    response.status(statusCode.OK).json({
      status: "success",
      message: messages.PASSWORD_RESET_SUCCESS,
    });
  } catch (error) {
    next(error);
  }
};

const createCustomerPreference = async (request, response, next) => {
  const transaction = await sequelize.transaction();
  try {
    const { customer_id, email } = request.params; // retrieve customer_id from the middleware
    //check if preference already exists
    const preference = await Preferences.findOne({
      where: { customer_id },
    });
    if (preference !== null) {
      throw new Error(messages.PREFERENCE_ALREADY_EXISTS);
    }
    const {
      daily_verse_count,
      start_surah,
      start_verse,
      is_language,
      timezone,
      frequency,
      schedule_time,
      start_date,
    } = request.body;
    const { error } = preferenceValidation(request.body);
    if (error !== undefined) {
      throw new Error(
        error.details[0].message || messages.SOMETHING_WENT_WRONG
      );
    }
    //check that the time is not lagging behind the schedule time
    const currentTime = new Date();
    const scheduleTime = new Date(schedule_time);
    if (scheduleTime < currentTime) {
      throw new Error(messages.SCHEDULE_TIME_INVALID);
    }


    const preference_id = uuidv4();
    await Preferences.create(
      {
        customer_id: customer_id,
        preference_id: preference_id,
        email: email,
        daily_verse_count: daily_verse_count,
        start_surah: start_surah,
        start_verse: start_verse,
        is_language: is_language,
        timezone: timezone,
        frequency: frequency,
        schedule_time: schedule_time,
        start_date: start_date,
      },
      { transaction }
    );

    await Email_logs.create(
      {
        preference_id: preference_id,
        customer_id: customer_id,
        last_sent_surah: start_surah,
        last_sent_verse: start_verse,
        next_sending_date: start_date,
      },
      { transaction }
    );
    await transaction.commit();
    response.status(statusCode.OK).json({
      status: "success",
      message: messages.CUSTOMER_PREFERENCE_CREATED,
    });
  } catch (error) {
    next(error);
  }
};

const getCustomerPreferences = async (request, response, next) => {
  try {
    const { customer_id } = request.params;

    const [preferences, emailLogs] = await Promise.all([
      Preferences.findOne({
        where: { customer_id },
        attributes: [
          "daily_verse_count",
          "start_surah",
          "start_verse",
          "frequency",
          "schedule_time",
          "start_date",
          "is_language",
          "timezone",
          
        ],
        raw: true, // Return plain object instead of Sequelize instance
      }),
      Email_logs.findOne({
        where: { customer_id },
        attributes: [
          "last_sent_surah",
          "last_sent_verse",
          "next_sending_date",
          "verse_completed",
          "surah_completed",
          "created_at",
          "updated_at",
        ],
        raw: true, // Return plain array of objects
      }),
    ]);

    // Combine preferences with email logs
    const result = preferences ? preferences : {};
    preferences ? (result.emailLogs = emailLogs) : {};

    response.status(200).json({
      status: "success",
      message: "Customer preferences and email logs retrieved successfully",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

const updatePreference = async (request, response, next) => {
  const transaction = await sequelize.transaction();
  try {
    const { customer_id } = request.params; // retrieve customer_id from the middleware
    const data = request.body;
    if (!data || Object.keys(data).length === 0) {
      throw new Error("invalid data");
    }
    const { error } = updatePreferenceValidation(data);
    if (error) {
      throw new Error(
        error.details[0].message || messages.SOMETHING_WENT_WRONG
      );
    }

    // Update Preferences
    await Preferences.update(data, {
      where: { customer_id },
      transaction,
    });

    // Update Email Logs (if needed, based on request body content)
    if (data.start_surah || data.start_verse || data.start_date) {
      await Email_logs.update(
        {
          ...(data.start_surah && { last_sent_surah: data.start_surah }),
          ...(data.start_verse && { last_sent_verse: data.start_verse }),
          ...(data.start_date && { next_sending_date: data.start_date }),
        },
        {
          where: { customer_id },
          transaction,
        }
      );
    }

    await transaction.commit();

    response.status(statusCode.OK).json({
      status: "success",
      message: messages.CUSTOMER_PREFERENCE_UPDATED,
    });
  } catch (error) {
    next(error);
  }
};

const randomVerse = async (request, response, next) => {
  try {
    const data = await generateRandomVerse();
    response.status(statusCode.OK).json({
      status: "success",
      message: messages.RANDOM_VERSE_FOUND,
      data: data,
    });
  } catch (error) {
    next(error);
  }
};

const initiateDonation = async (request, response, next) => {
  try {
    const { email, amount } = request.body;

    if (!email || !amount) {
      throw new Error("Invalid email or amount");
    }

    const response = await initializePayment(email, amount);

    response.status(statusCode.OK).json({
      status: "success",
      message: "Payment initialized success fully",
      data: {
        payment_url: response.data.data.authorization_url,
        access_code: response.data.data.reference,
      },
    });
  } catch (error) {
    next(error);
  }
};

const verifyDonation = async (request, response, next) => {
  try {
    const { reference } = request.params;

    const response = await verifyPayment(reference);

    if (response.data.data.status !== "status") {
      throw new Error("Invalid transaction or payment failed");
    }
    response.status(statusCode.OK).json({
      status: "success",
      message: messages.DONATED_SUCCESS,
    });
  } catch (error) {
    next(error);
  }
};

const createBookmark = async (request, response, next) => {
  try {
    const { customer_id } = request.params; // retrieve customer_id from the middleware
    const { surah, verse } = request.body;

    const existingBookmark = await Bookmark.findOne({
      where: { customer_id, surah, verse },
    });
    if (existingBookmark !== null) {
      throw new Error(`Bookmark already exists`);
    }

    const bookmark = await Bookmark.create({
      bookmark_id: uuidv4(),
      customer_id,
      surah,
      verse,
      created_at: new Date(),
    });

    response.status(statusCode.OK).json({
      status: "success",
      message: messages.BOOKMARK_CREATED,
      data: bookmark,
    });
  } catch (error) {
    console.error(error);
    next(error);
  }
};

const getBookmarks = async (request, response, next) => {
  try {
    const { customer_id } = request.params; // retrieve customer_id from the middleware

    const bookmarks = await Bookmark.findAll({
      where: {
        customer_id,
      },
    });
    response.status(statusCode.OK).json({
      status: "success",
      message: messages.BOOKMARKS_FETCHED,
      data: bookmarks,
    });
  } catch (error) {
    next(error);
  }
};

const deleteBookmark = async (request, response, next) => {
  try {
    const { bookmark_id, customer_id } = request.params;

    await Bookmark.destroy({
      where: {
        customer_id,
        bookmark_id: bookmark_id,
      },
    });

    response.status(statusCode).json({
      status: "success",
      message: messages.BOOKMARK_DELETED,
    });
  } catch (error) {
    next(error);
  }
};

const processEmail = async () => {
  try {
    // Fetch customer logs and preferences
    const customerLogsAndPreferences = await fetchLogsAndPreferences();
    if (customerLogsAndPreferences === undefined) return;

    const normalizedResults = Array.isArray(customerLogsAndPreferences)
      ? customerLogsAndPreferences
      : [customerLogsAndPreferences];

    const filteredResult = normalizedResults.filter((log) => {
      const scheduleTime = moment(log.schedule_time, "HH:mm:ss");
      const currentTime = moment();
      return (
        scheduleTime.hours() === currentTime.hours() &&
        scheduleTime.minutes() === currentTime.minutes()
      );
    });

    if (filteredResult.length === 0) return;

    for (const log of filteredResult) {
      const {
        preference_id,
        email,
        daily_verse_count,
        start_surah,
        start_verse,
        is_language,
        frequency,
        last_sent_surah,
        last_sent_verse,
        surah_completed,
        verse_completed,
      } = log;

      let currentSurah = last_sent_surah;
      let currentVerse = last_sent_verse;

      // Fetch verses using `getVerses`
      const verses = await getVerses(
        currentSurah,
        currentVerse,
        daily_verse_count,
        is_language ? ["ar", is_language] : ["ar"]
      );

      // Format the fetched verses
      const message = formatQuranEmailTemplate(
        verses,
        is_language ? "success" : false
      );

      // Send email
      sendEmail(email, message, "Your Verse for Today");

      // Determine the new surah and verse for the next email
      const lastFetchedVerse = verses[verses.length - 1];
      const nextSurah = lastFetchedVerse.chapter;
      const nextVerse = lastFetchedVerse.verse + 1;

      // Increment surah_completed if the surah has changed
      const updatedSurahCompleted =
        nextSurah > currentSurah ? surah_completed + 1 : surah_completed;

      // Update email log
      Email_logs.update(
        {
          last_sent_surah: nextSurah,
          last_sent_verse: nextVerse,
          next_sending_date: calculateNextSendingDate(frequency),
          verse_completed: verse_completed + daily_verse_count,
          surah_completed: updatedSurahCompleted,
        },
        { where: { preference_id } }
      );
    }
  } catch (error) {
    console.error("Error processing email:", error);
  }
};

cron.schedule("*/1 * * * *", async () => {
  console.log("Cron job started: Processing daily emails...");
  await processEmail();
  console.log("Cron job completed: Emails sent.");
});

module.exports = {
  createCustomer,
  verifyEmail,
  resendOtp,
  login,
  updateCustomer,
  getCustomer,
  getCustomerPreferences,
  startForgetPassword,
  completeForgetPassword,
  createCustomerPreference,
  updatePreference,
  randomVerse,
  initiateDonation,
  verifyDonation,
  createBookmark,
  getBookmarks,
  deleteBookmark,
};
