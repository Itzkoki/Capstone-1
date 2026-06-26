const db = require('../config/db');
const User = require('../models/User');
const Notification = require('../models/Notification');
const Article = require('../models/Article');
const Meeting = require('../models/Meeting');
const ActivityLog = require('../models/ActivityLog');

// GET /api/dashboard
const getDashboard = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;

    // Base data for all roles
    const unreadNotifications = await Notification.getUnreadCount(userId);
    const recentNotifications = await Notification.findByUserId(userId, 5);
    const articleCount = await Article.getCount();
    const activeMeetings = await Meeting.getActiveCount();

    let dashboardData = {
      role,
      unreadNotifications,
      recentNotifications,
      articleCount,
      activeMeetings,
    };

    switch (role) {
      case 'client':
        dashboardData.summary = 'Welcome to Barcarse Psychological Services. Browse articles and manage your profile.';
        dashboardData.quickActions = [
          { label: 'My Profile', link: 'profile.html' },
          { label: 'Browse Articles', link: 'community.html' },
          { label: 'Intake Form', link: 'intakeform.html' },
        ];
        break;

      // Per-role Quick Actions mirror the role-based navbar: each role sees ONLY
      // its own module(s) plus Teleconference (every staff role can host/create a
      // session). The Clinical Director sees everything.
      case 'psychometrician':
        dashboardData.summary = 'Review client intake submissions and manage their appointment schedules.';
        dashboardData.quickActions = [
          { label: 'Case Management', link: 'case-dashboard.html' },
          { label: 'Teleconference', link: 'meetings.html' },
        ];
        break;

      case 'supervising_psychometrician':
        dashboardData.summary = 'Verify client payment submissions once the appointment schedule is approved.';
        dashboardData.quickActions = [
          { label: 'Payment Verification', link: 'payments-admin.html' },
          { label: 'Teleconference', link: 'meetings.html' },
        ];
        break;

      case 'qc_psychometrician':
        dashboardData.summary = 'Manage report templates and oversee quality assurance.';
        dashboardData.quickActions = [
          { label: 'Manage Templates', link: 'psych-reports.html#manageTpl' },
          { label: 'Teleconference', link: 'meetings.html' },
        ];
        break;

      case 'psychologist':
        dashboardData.summary = 'Generate psychological reports, provide diagnoses, and finalize approvals.';
        dashboardData.quickActions = [
          { label: 'Psych Reports', link: 'psych-reports.html' },
          { label: 'Create Report', link: 'psych-reports.html#create' },
          { label: 'Teleconference', link: 'meetings.html' },
        ];
        break;

      case 'clinical_director': {
        const totalStaff = await User.getTotalCount();
        const recentActivity = await ActivityLog.findAll({ limit: 10 });

        // Staff by role count
        const roleCountResult = await db.query(
          `SELECT role, COUNT(*) AS count FROM users GROUP BY role ORDER BY role`
        );

        dashboardData.summary = 'System-wide operations, staff management, and workflow oversight.';
        dashboardData.totalStaff = totalStaff;
        dashboardData.staffByRole = roleCountResult.rows;
        dashboardData.recentActivity = recentActivity;
        dashboardData.quickActions = [
          { label: 'Psych Reports', link: 'psych-reports.html' },
          { label: 'Create Report', link: 'psych-reports.html#create' },
          { label: 'Manage Templates', link: 'psych-reports.html#manageTpl' },
          { label: 'Manage Staff', link: 'staff-management.html' },
          { label: 'Case Management', link: 'case-dashboard.html' },
          { label: 'Payment Verification', link: 'payments-admin.html' },
          { label: 'Teleconference', link: 'meetings.html' },
        ];
        break;
      }
    }

    return res.status(200).json({ success: true, data: dashboardData });
  } catch (error) {
    next(error);
  }
};

module.exports = { getDashboard };
