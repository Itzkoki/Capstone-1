const { body, validationResult } = require('express-validator');

// ── Common / weak password blocklist ──────────────────
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'pass1234', 'passw0rd',
  '123456', '1234567', '12345678', '123456789', '1234567890',
  '111111', '000000', '654321', '987654321',
  'qwerty', 'qwerty123', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm',
  'abc123', 'abcdef', 'abcd1234', 'letmein', 'welcome',
  'monkey', 'dragon', 'master', 'login', 'admin', 'administrator',
  'iloveyou', 'trustno1', 'sunshine', 'princess', 'football',
  'shadow', 'michael', 'superman', 'batman', 'access',
  'hello123', 'charlie', 'donald', 'baseball', 'starwars',
  '!@#$%^&*', 'p@ssw0rd', 'p@ssword', 'changeme', 'welcome1',
  'test1234', 'guest', 'default', 'root', 'toor',
]);

/** Reusable password‑strength chain for express-validator */
function strongPasswordRules(fieldName = 'password') {
  return body(fieldName)
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 12 })
    .withMessage('Password must be at least 12 characters')
    .isLength({ max: 128 })
    .withMessage('Password must be at most 128 characters')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number')
    .matches(/[^A-Za-z0-9]/)
    .withMessage('Password must contain at least one special character (e.g. !@#$%^&*)')
    .custom((value) => {
      if (COMMON_PASSWORDS.has(value.toLowerCase())) {
        throw new Error('This password is too common. Please choose a stronger password.');
      }
      return true;
    });
}

// ── Validation rule sets ──────────────────────────────

const registerRules = [
  body('full_name')
    .trim()
    .notEmpty()
    .withMessage('Nickname is required')
    .isLength({ max: 100 })
    .withMessage('Nickname must be at most 100 characters'),

  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),

  strongPasswordRules('password'),

  body('contact_number')
    .trim()
    .notEmpty()
    .withMessage('Contact number is required')
    .matches(/^[+]?[\d\s()-]{7,20}$/)
    .withMessage('Please provide a valid contact number'),
];

const loginRules = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),

  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

const verifyEmailRules = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),

  body('otp')
    .trim()
    .notEmpty()
    .withMessage('Verification code is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('Verification code must be 6 digits')
    .isNumeric()
    .withMessage('Verification code must contain only numbers'),
];

const resendOtpRules = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
];

const forgotPasswordRules = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
];

const resetPasswordRules = [
  body('token')
    .trim()
    .notEmpty()
    .withMessage('Reset token is required'),

  strongPasswordRules('password'),
];

// ── Middleware to check validation results ────────────

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map((err) => ({
        field: err.path,
        message: err.msg,
      })),
    });
  }
  next();
};

module.exports = {
  registerRules,
  loginRules,
  verifyEmailRules,
  resendOtpRules,
  forgotPasswordRules,
  resetPasswordRules,
  handleValidation,
};
