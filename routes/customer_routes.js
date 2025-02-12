const express = require("express");
const router = express.Router();
const {
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
} = require("../controllers/customer_controllers");
const { authorization } = require("../middlewares/authorization");

router.post("/customer", createCustomer);
router.patch("/verify-email/:email/:otp", verifyEmail);
router.patch("/resend-otp/:email", resendOtp);
router.post("/customer/login", login);
router.patch("/customer", authorization, updateCustomer);
router.get("/customer", authorization, getCustomer);
router.patch("/customer/forget-password/:email", startForgetPassword);
router.post("/customer/forget-password/complete", completeForgetPassword);
router.post("/customer/preference", authorization, createCustomerPreference);
router.get("/customer/preference", authorization, getCustomerPreferences);
router.patch("/customer/preference", authorization, updatePreference);
router.get("/customer/random-verse", randomVerse);
router.post("/donation/initiate", initiateDonation);
router.post("/donation/verify/:reference", verifyDonation);
router.post("/customer/bookmark", authorization, createBookmark);
router.get("/customer/bookmarks", authorization, getBookmarks);
router.delete("/customer/bookmark/:id", authorization, deleteBookmark);

module.exports = router;
