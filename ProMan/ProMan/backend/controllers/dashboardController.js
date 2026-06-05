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

      case 'psychometrician':
        dashboardData.summary = 'View assigned clients, access intake data, and manage assessment records.';
        dashboardData.quickActions = [
          { label: 'Intake Submissions', link: 'intake-submissions.html' },
          { label: 'Articles', link: 'articles.html' },
          { label: 'Meetings', link: 'meetings.html' },
        ];
        break;

      case 'supervising_psychometrician':
        dashboardData.summary = 'Review assessment records and verify scoring accuracy.';
        dashboardData.quickActions = [
          { label: 'Intake Submissions', link: 'intake-submissions.html' },
          { label: 'Articles', link: 'articles.html' },
          { label: 'Meetings', link: 'meetings.html' },
        ];
        break;

      case 'qc_psychometrician':
        dashboardData.summary = 'Conduct final validation of assessment results before psychologist review.';
        dashboardData.quickActions = [
          { label: 'Intake Submissions', link: 'intake-submissions.html' },
          { label: 'Articles', link: 'articles.html' },
          { label: 'Meetings', link: 'meetings.html' },
        ];
        break;

      case 'psychologist':
        dashboardData.summary = 'Generate reports, provide diagnoses, and finalize approvals.';
        dashboardData.quickActions = [
          { label: 'Psych Reports', link: 'psych-reports.html' },
          { label: 'Intake Submissions', link: 'intake-submissions.html' },
          { label: 'Articles', link: 'articles.html' },
          { label: 'Meetings', link: 'meetings.html' },
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
          { label: 'Manage Staff', link: 'staff-management.html' },
          { label: 'Intake Submissions', link: 'intake-submissions.html' },
          { label: 'Articles', link: 'articles.html' },
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
