# ProMan Authentication Backend

Secure user authentication API built with **Node.js (Express)** and **PostgreSQL**, featuring **email verification via SendGrid**.

## Features

- User registration with bcrypt password hashing (12 salt rounds)
- **Email verification using 6-digit OTP** (15-min expiry, hashed storage, single-use)
- JWT-based login authentication (blocked until email is verified)
- Input validation (email format, required fields, contact number format)
- Parameterized SQL queries (SQL injection prevention)
- Modular architecture (routes → middleware → controllers → models → services)
- Environment-based configuration

## Prerequisites

- **Node.js** ≥ 18
- **PostgreSQL** ≥ 14
- **SendGrid account** with a verified sender email

## Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment

Copy the template and update with your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=5000
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_actual_password
DB_NAME=proman_db
JWT_SECRET=generate_a_strong_random_secret
JWT_EXPIRES_IN=1h
SENDGRID_API_KEY=your_sendgrid_api_key
SENDGRID_FROM_EMAIL=your_verified_sender@example.com
```

### 3. Create the Database & Schema

```sql
-- In psql or pgAdmin:
CREATE DATABASE proman_db;
```

Then apply the schema:

```bash
psql -U postgres -d proman_db -f schema.sql
```

### 4. Start the Server

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

Server runs at `http://localhost:5000`.

## API Endpoints

### `POST /api/auth/register`

Register a new user. Sends a 6-digit verification OTP to the provided email.

**Request Body:**

```json
{
  "full_name": "John Doe",
  "email": "john@example.com",
  "password": "securePass123",
  "contact_number": "+1234567890"
}
```

**Responses:**

| Status | Description |
|--------|-------------|
| `201`  | User registered — verification email sent |
| `400`  | Validation error (missing/invalid fields) |
| `409`  | Email already exists |

---

### `POST /api/auth/verify-email`

Verify email using the 6-digit OTP received via email.

**Request Body:**

```json
{
  "email": "john@example.com",
  "otp": "482917"
}
```

**Responses:**

| Status | Description |
|--------|-------------|
| `200`  | Email verified successfully |
| `400`  | Invalid/expired OTP, already verified, or validation error |

---

### `POST /api/auth/login`

Authenticate and receive a JWT token. **Requires verified email.**

**Request Body:**

```json
{
  "email": "john@example.com",
  "password": "securePass123"
}
```

**Responses:**

| Status | Description |
|--------|-------------|
| `200`  | Login successful — returns JWT token + user info |
| `400`  | Validation error |
| `401`  | Invalid credentials |
| `403`  | Email not verified |

---

### `GET /api/health`

Health check endpoint — returns `{ "status": "ok" }`.

## Project Structure

```
backend/
├── config/
│   └── db.js              # PostgreSQL connection pool
├── controllers/
│   └── authController.js  # Register, login & verify logic
├── middleware/
│   └── validate.js        # Input validation rules
├── models/
│   ├── User.js            # User database queries
│   └── Verification.js    # OTP verification queries
├── routes/
│   └── auth.js            # Route definitions
├── services/
│   └── emailService.js    # SendGrid email integration
├── .env.example           # Environment template
├── schema.sql             # Database schema
├── server.js              # Express app entry point
└── package.json
```
