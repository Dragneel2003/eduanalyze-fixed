# 📊 EduAnalyze Vision

> AI-powered CBSE answer sheet evaluation system with WhatsApp delivery

---

## 🚀 Quick Start

### 1. Prerequisites

```bash
# Node.js 18+
node --version

# Poppler (for PDF → image conversion)
# Ubuntu/Debian:
sudo apt-get install poppler-utils

# macOS:
brew install poppler
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

Required variables:

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Your OpenAI API key |
| `SESSION_SECRET` | Random string for sessions |
| `BASE_URL` | Your app's public URL |
| `WA_TOKEN` | WhatsApp Cloud API bearer token |
| `WA_PHONE_ID` | WhatsApp Phone Number ID |

### 4. Run

```bash
npm start
# or for development:
npm run dev
```

Open **http://localhost:3000**

**Default password:** `admin123` ← Change this immediately!

---

## 📂 Input File Formats

### Answer Sheets (PDF)
Filename format: `ROLLNO_StudentName.pdf`

Examples:
```
101_Rahul_Sharma.pdf
102_Anshul.pdf
203_Priya_Gupta.pdf
```

### Excel Mapping (.xls / .xlsx)
| Column A | Column B |
|----------|----------|
| Roll No  | WhatsApp Number |
| 101      | 919876543210 |
| 102      | 917654321098 |

- Phone numbers: country code + number (no spaces, no +)
- Header row is auto-skipped

---

## 🏗️ Project Structure

```
eduanalyze/
├── server.js          # Main Express server
├── package.json
├── password.json      # Bcrypt-hashed admin password
├── .env               # Environment variables (create from .env.example)
├── render.yaml        # Render.com deployment config
├── public/
│   └── index.html     # Admin dashboard
├── outputs/           # Generated PDF reports (auto-created)
└── uploads/           # Temp upload directory (auto-created)
```

---

## 🌐 API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/login` | ✗ | Login |
| POST | `/api/logout` | ✓ | Logout |
| GET | `/api/session` | ✗ | Check session |
| POST | `/api/change-password` | ✓ | Change password |
| POST | `/api/process` | ✓ | Process answer sheets |
| GET | `/api/reports` | ✓ | List all reports |
| DELETE | `/api/reports` | ✓ | Clear reports |
| GET | `/download/:filename` | ✓ | Download PDF report |
| GET | `/health` | ✗ | Health check |

---

## 🚀 Deploy on Render

1. Push code to GitHub
2. Create new Web Service on [render.com](https://render.com)
3. Connect your GitHub repo
4. Set Build Command: `npm install`
5. Set Start Command: `node server.js`
6. Add environment variables from `.env.example`
7. Add this to Build Command to install poppler:
   ```
   apt-get install -y poppler-utils && npm install
   ```

> **Note:** On Render free tier, files in `/outputs` are temporary and reset on each deploy. Consider using Cloudinary or S3 for persistent storage in production.

---

## 🔐 Security Notes

- Change the default password (`admin123`) immediately after first login
- Use a strong `SESSION_SECRET` in production
- Sessions expire after 8 hours
- All download routes are auth-protected

---

## 📝 Grade Scale (CBSE)

| Marks | Grade |
|-------|-------|
| 91–100% | A1 |
| 81–90% | A2 |
| 71–80% | B1 |
| 61–70% | B2 |
| 51–60% | C1 |
| 41–50% | C2 |
| 33–40% | D |
| Below 33% | E (Fail) |

---

## 🛠️ WhatsApp Setup (Meta Cloud API)

1. Go to [Meta Developer Portal](https://developers.facebook.com)
2. Create App → Business → WhatsApp
3. Get `Phone Number ID` and `Access Token`
4. Set in `.env` as `WA_PHONE_ID` and `WA_TOKEN`
5. The app sends a text message + PDF document to each student

> If WhatsApp is not configured, processing still works — reports are generated and available for download. WhatsApp status will show "N/A" in the dashboard.
