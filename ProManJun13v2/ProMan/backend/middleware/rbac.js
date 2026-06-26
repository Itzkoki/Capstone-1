/**
 * RBAC (Role-Based Access Control) middleware.
 *
 * Role hierarchy (highest → lowest):
 *   clinical_director > psychologist > qc_psychometrician > supervising_psychometrician > psychometrician
 */

const ROLE_LEVELS = {
  client: 0,
  staff: 1,
  psychometrician: 1,
  supervising_psychometrician: 2,
  qc_psychometrician: 3,
  psychologist: 4,
  clinical_director: 5,
};

/**
 * Allow only specific roles.
 * Usage: router.get('/staff', authenticate, authorize('clinical_director'), handler)
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. No role assigned.',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
      });
    }

    next();
  };
};

/**
 * Allow roles at or above a minimum level.
 * Usage: router.get('/reports', authenticate, authorizeMinRole('psychologist'), handler)
 */
const authorizeMinRole = (minRole) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. No role assigned.',
      });
    }

    const userLevel = ROLE_LEVELS[req.user.role] || 0;
    const requiredLevel = ROLE_LEVELS[minRole] || 0;

    if (userLevel < requiredLevel) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
      });
    }

    next();
  };
};

module.exports = { authorize, authorizeMinRole, ROLE_LEVELS };
