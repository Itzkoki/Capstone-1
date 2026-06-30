const { body } = require('express-validator');

// Contact number: digits only (Philippine mobile 09XXXXXXXXX = 11 digits).
const PH_PHONE_REGEX = /^09\d{9}$/;

const GENDER_VALUES = ['male', 'female', 'other', 'prefer_not_to_say'];
const CIVIL_STATUS_VALUES = ['single', 'married', 'widowed', 'separated', 'divorced'];

/**
 * Validation rules for PUT /api/profile.
 * All fields are optional (partial update).
 */
const updateProfileRules = [
  body('full_name')
    .optional()
    .trim()
    .notEmpty().withMessage('Nickname cannot be empty')
    .isLength({ max: 100 }).withMessage('Nickname must be at most 100 characters'),

  body('email')
    .optional()
    .trim()
    .isEmail().withMessage('Email must follow a valid format (RFC 5322)')
    .normalizeEmail(),

  body('contact_number')
    .optional()
    .trim()
    .matches(PH_PHONE_REGEX)
    .withMessage('Contact number must be digits only in the format 09XXXXXXXXX (11 numbers)'),

  body('gender')
    .optional()
    .trim()
    .isIn(GENDER_VALUES)
    .withMessage(`Gender must be one of: ${GENDER_VALUES.join(', ')}`),

  body('date_of_birth')
    .optional()
    .isISO8601().withMessage('Date of birth must be a valid date (YYYY-MM-DD)')
    .custom((value) => {
      if (new Date(value) > new Date()) {
        throw new Error('Date of birth cannot be in the future');
      }
      return true;
    }),

  body('civil_status')
    .optional()
    .trim()
    .isIn(CIVIL_STATUS_VALUES)
    .withMessage(`Civil status must be one of: ${CIVIL_STATUS_VALUES.join(', ')}`),

  body('address')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Address must be at most 500 characters'),

  // Health fields (optional, max 2000 chars)
  body('medical_history')
    .optional()
    .trim()
    .isLength({ max: 2000 }).withMessage('Medical history must be at most 2000 characters'),

  body('current_medications')
    .optional()
    .trim()
    .isLength({ max: 2000 }).withMessage('Current medications must be at most 2000 characters'),

  body('previous_treatments')
    .optional()
    .trim()
    .isLength({ max: 2000 }).withMessage('Previous treatments must be at most 2000 characters'),

  // Privacy settings (optional booleans)
  body('privacy.show_contact_number').optional().isBoolean().withMessage('Must be a boolean'),
  body('privacy.show_date_of_birth').optional().isBoolean().withMessage('Must be a boolean'),
  body('privacy.show_address').optional().isBoolean().withMessage('Must be a boolean'),
  body('privacy.show_medical_history').optional().isBoolean().withMessage('Must be a boolean'),
  body('privacy.show_current_medications').optional().isBoolean().withMessage('Must be a boolean'),
  body('privacy.show_previous_treatments').optional().isBoolean().withMessage('Must be a boolean'),
];

module.exports = { updateProfileRules };
