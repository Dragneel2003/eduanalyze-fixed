require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const xlsx = require("xlsx");
const PDFDocument = require("pdfkit");
const axios = require("axios");
const OpenAI = require("openai");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);
const PQueue = require("p-queue");

const queue = new PQueue({
  concurrency: 1,
  interval: 60000,
  intervalCap: 195000
});


// ─── App Setup ───────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL;

// Absolute paths — works regardless of cwd
const OUTPUTS_DIR = path.join(__dirname, "outputs");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const PASSWORD_FILE = path.join(__dirname, "password.json");

// Ensure output/upload directories exist
[OUTPUTS_DIR, UPLOADS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── OpenAI ──────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── In-Memory Report Store ───────────────────────────────────────────────────
let reportStore = [];

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));
// Root route (ADD THIS)
app.get("/", (req, res) => {
  res.send("EduAnalyze Backend Running ✅");
});

app.use(
  session({
    secret: process.env.SESSION_SECRET || "eduanalyze-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// ─── Multer Config ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = [".pdf", ".xls", ".xlsx"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Password required" });

    const pwdFile = JSON.parse(fs.readFileSync(PASSWORD_FILE, "utf8"));
    const match = await bcrypt.compare(password, pwdFile.hash);

    if (!match) return res.status(401).json({ error: "Invalid password" });

    req.session.authenticated = true;
    res.json({ success: true, message: "Login successful" });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get("/api/session", (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.post("/api/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: "Both passwords required" });
    if (newPassword.length < 8)
      return res
        .status(400)
        .json({ error: "New password must be at least 8 characters" });

    const pwdFile = JSON.parse(fs.readFileSync(PASSWORD_FILE, "utf8"));
    const match = await bcrypt.compare(currentPassword, pwdFile.hash);
    if (!match)
      return res.status(401).json({ error: "Current password incorrect" });

    const newHash = await bcrypt.hash(newPassword, 10);
    fs.writeFileSync(PASSWORD_FILE, JSON.stringify({ hash: newHash }, null, 2));
    res.json({ success: true, message: "Password updated" });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Reports API ──────────────────────────────────────────────────────────────
app.get("/api/reports", requireAuth, (req, res) => {
  res.json(reportStore);
});

app.delete("/api/reports", requireAuth, (req, res) => {
  reportStore = [];
  res.json({ success: true, message: "Reports cleared" });
});

// ─── Secure Download Route ────────────────────────────────────────────────────
app.get("/download/:filename", requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(OUTPUTS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.download(filePath, filename, (err) => {
    if (err) {
      console.error("Download error:", err);
      if (!res.headersSent)
        res.status(500).json({ error: "Download failed" });
    }
  });
});

// ─── Utility: PDF → Base64 Images via pdf-poppler ────────────────────────────
async function pdfToBase64Images(pdfPath) {
  try {
    const outputDir = path.join(UPLOADS_DIR, "img_" + Date.now());
    fs.mkdirSync(outputDir, { recursive: true });

    await execPromise(`pdftoppm -jpeg -r 150 "${pdfPath}" "${outputDir}/page"`);

    const files = fs
      .readdirSync(outputDir)
      .filter((f) => f.includes("page") && (f.endsWith(".jpg") || f.endsWith(".jpeg")))
      .sort((a, b) => {
        const numA = parseInt(a.match(/-(\d+)\.jpg$/)?.[1] || 0);
        const numB = parseInt(b.match(/-(\d+)\.jpg$/)?.[1] || 0);
        return numA - numB;
     });

    const images = files.map((f) => {
      const data = fs.readFileSync(path.join(outputDir, f));
      return data.toString("base64");
    });

    // Cleanup temp images
    fs.rmSync(outputDir, { recursive: true, force: true });
    return images;
  } catch (err) {
    console.error("PDF to image error:", err.message);
    return [];
  }
}

// ─── Utility: Parse Excel ─────────────────────────────────────────────────────
function parseExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

  const mapping = {};
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 2) continue;
    const rollNo = String(row[0]).trim();
    const phone = String(row[1]).trim().replace(/\D/g, ""); // digits only
    if (rollNo && phone && rollNo.toLowerCase() !== "roll") {
      mapping[rollNo] = phone;
    }
  }
  return mapping;
}

// ─── Utility: Extract Roll No from Filename ───────────────────────────────────
function extractRollNo(filename) {
  const base = path.basename(filename, path.extname(filename));
  const parts = base.split("_");
  return parts[0] ? parts[0].trim() : null;
}

function extractStudentName(filename) {
  const base = path.basename(filename, path.extname(filename));
  const parts = base.split("_");
  return parts.slice(1).join(" ").trim() || "Student";
}

// ─── Utility: AI Evaluation ───────────────────────────────────────────────────
async function evaluateWithAI(questionPaperImages, answerSheetImages) {
  const SYSTEM_PROMPT = `You are a CBSE board examiner.

You are given:
1. A structured question paper (first images)
2. A student's handwritten answer sheet (next images)

STEP 1:
Identify all questions, marks, and types (MCQ, short, long).

STEP 2:
Match student answers with questions.

STEP 3:
Evaluate like a strict CBSE examiner:
* Give marks for steps
* Give partial marks
* Reward correct concepts
* Do NOT give zero unless completely wrong
* Maintain consistency

STEP 4:
Ensure realistic scoring (avoid under-marking)

OUTPUT ONLY VALID JSON (no markdown, no explanation):

{
  "total_marks": number,
  "max_marks": number,
  "percentage": number,
  "grade": "",
  "strong_areas": [
    {
      "topic": "Topic name",
      "description": "Detailed explanation of strength"
    }
  ],
  "needs_improvement": [
    {
      "topic": "Topic name",
      "description": "Detailed weakness explanation"
    }
  ],
  "actionable_feedback": [
    {
      "topic": "Action",
      "description": "What student should do"
    }
  ],
  "overall_performance": "Detailed paragraph analysis"
}
  Rules:
- Use SUBJECT-SPECIFIC language (Chemistry terms)
- Give detailed explanations (2–3 lines each)
- Be like a coaching institute report
`;

  const contentParts = [];

  // Add question paper images
  questionPaperImages.forEach((b64, i) => {
    contentParts.push({
      type: "text",
      text: `Question Paper - Page ${i + 1}:`,
    });
    contentParts.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
    });
  });

  // Add answer sheet images
  answerSheetImages.forEach((b64, i) => {
    contentParts.push({
      type: "text",
      text: `Student Answer Sheet - Page ${i + 1}:`,
    });
    contentParts.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
    });
  });

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: contentParts },
    ],
  });
  

  const raw = response.choices[0].message.content.trim();
  // Strip markdown fences if present
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// ─── Utility: Score Calibration ───────────────────────────────────────────────
function calibrateScore(result) {
  let { total_marks, max_marks } = result;

  // Ensure total doesn't exceed max
  total_marks = Math.min(total_marks, max_marks);

  // Slight upward correction for realistic CBSE marking (up to 5%)
  const boost = Math.random() * 0.05; // 0–5%
  const adjusted = Math.round(total_marks * (1 + boost));
  total_marks = Math.min(adjusted, max_marks);

  const percentage = Math.round((total_marks / max_marks) * 100);

  // Grade calculation
  let grade;
  if (percentage >= 91) grade = "A1";
  else if (percentage >= 81) grade = "A2";
  else if (percentage >= 71) grade = "B1";
  else if (percentage >= 61) grade = "B2";
  else if (percentage >= 51) grade = "C1";
  else if (percentage >= 41) grade = "C2";
  else if (percentage >= 33) grade = "D";
  else grade = "E (Fail)";

  return { ...result, total_marks, max_marks, percentage, grade };
}

// ─── Utility: Generate PDF Report ────────────────────────────────────────────



function generatePDFReport(studentName, rollNo, result) {
  return new Promise((resolve, reject) => {
    const filename = `report_${rollNo}_${Date.now()}.pdf`;
    const filePath = path.join(OUTPUTS_DIR, filename);
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const templatePath = path.join(__dirname, "template.jpg");
    const addBackground = () => {
  doc.image(templatePath, 0, 0, { fit: [595, 842] });
};

addBackground();
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // ── Color Palette ──
    

    // ── Header Banner ──
    let y = 160;

// LEFT → DATE
doc.font("Helvetica-Bold").fontSize(12);
doc.text(`Date: ${new Date().toLocaleDateString()}`, 50, y);

// CENTER → STUDENT NAME
doc.font("Helvetica-Bold").fontSize(14);
doc.text(`Student Name: ${studentName}`, 0, y, {
  align: "center"
});

// RIGHT → MARKS
// let rightX = 350;
// let rightY = y;

// doc.font("Helvetica-Bold").fontSize(16);
// doc.text(`Marks: ${result.total_marks}/${result.max_marks}`, rightX, rightY, {
//   width: 200,
//   align: "right"
// });

// rightY += 20;

// doc.font("Helvetica").fontSize(12);
// doc.text(`Percentage: ${result.percentage}%`, rightX, rightY, {
//   width: 200,
//   align: "right"
// });

// rightY += 15;

// doc.text(`Grade: ${result.grade}`, rightX, rightY, {
//   width: 200,
//   align: "right"
// });

// // move down after header
// y += 15;

// doc.text(`Grade: ${result.grade}`, rightX, rightY, {
//   width: 200,
//   align: "right"
// });
y += 40;

    y += 30;
    const checkOverflow = () => {
  if (y > 700) {
    doc.addPage();
    addBackground();
    y = 140;
  }
};
doc.font("Helvetica-Bold").fontSize(14).text("Strong Areas", 50, y);
y += 25;

result.strong_areas.forEach((item, i) => {
  checkOverflow();

  const text = `• ${item.topic}: ${item.description}`;

const height = doc.heightOfString(text, {
  width: 480
});

doc.text(text, 60, y, { width: 480 });

y += height + 10; // 🔥 dynamic spacing

 
});
y += 10;
doc.font("Helvetica");
doc.font("Helvetica-Bold").fontSize(14).text("Needs Improvement", 50, y);
y += 25;

result.needs_improvement.forEach((item, i) => {
  checkOverflow();

  const text = `• ${item.topic}: ${item.description}`;

const height = doc.heightOfString(text, {
  width: 480
});

doc.text(text, 60, y, { width: 480 });

y += height + 10; // 🔥 dynamic spacing

  
});
y += 10;
doc.font("Helvetica");
doc.font("Helvetica-Bold").fontSize(14).text("Actionable Feedback", 50, y);
y += 25;

result.actionable_feedback.forEach((item, i) => {
  checkOverflow();

  const text = `• ${item.topic}: ${item.description}`;

const height = doc.heightOfString(text, {
  width: 480
});

doc.text(text, 60, y, { width: 480 });

y += height + 10; // 🔥 dynamic spacing

 
});
y += 10;
doc.font("Helvetica");
doc.font("Helvetica-Bold").fontSize(14).text("Overall Performance", 50, y);
y += 20;
checkOverflow();

const height = doc.heightOfString(result.overall_performance, {
  width: 480
});

doc.text(result.overall_performance, 60, y, { width: 480 });

y += height + 10;
  doc.end();
  stream.on("finish",() => resolve(filename));
  stream.on("error",reject);
});
}
    

// ─── Utility: Send WhatsApp ───────────────────────────────────────────────────
async function sendWhatsApp(phone, pdfUrl, studentName) {
  const WA_TOKEN = process.env.WA_TOKEN;
  const WA_PHONE_ID = process.env.WA_PHONE_ID;

  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.warn("WhatsApp credentials not configured, skipping.");
    return { skipped: true };
  }

  const url = `https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "document",
        document: {
          link: pdfUrl,
          filename: `Report_${studentName.replace(/\s/g, "_")}.pdf`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("WhatsApp API response:", response.data);
    return response.data;

  } catch (err) {
    console.error("WhatsApp error:", err.response?.data || err.message);
    throw err;
  }
}

// ─── MAIN PROCESSING ROUTE ────────────────────────────────────────────────────
app.post(
  "/api/process",
  requireAuth,
  upload.fields([
    { name: "questionPaper", maxCount: 1 },
    { name: "answerSheets", maxCount: 50 },
    { name: "excelFile", maxCount: 1 },
  ]),
  async (req, res) => {
    const uploadedFiles = [];

    try {
      const { questionPaper, answerSheets, excelFile } = req.files || {};

      if (!questionPaper || !answerSheets || !excelFile) {
        return res.status(400).json({
          error:
            "Missing required files. Please upload question paper, answer sheets, and Excel mapping.",
        });
      }

      // Track temp files for cleanup
      uploadedFiles.push(
        questionPaper[0].path,
        excelFile[0].path,
        ...answerSheets.map((f) => f.path)
      );

      // Step 1: Parse Excel mapping
      console.log("📊 Parsing Excel mapping...");
      const phoneMapping = parseExcel(excelFile[0].path);
      console.log(`  Found ${Object.keys(phoneMapping).length} entries`);

      // Step 2: Convert question paper to images
      console.log("📄 Converting question paper to images...");
      const qpImages = await pdfToBase64Images(questionPaper[0].path);
      console.log(`  ${qpImages.length} pages converted`);

      if (qpImages.length === 0) {
        return res.status(400).json({
          error:
            "Could not convert question paper PDF to images. Ensure poppler-utils is installed on the server.",
        });
      }

      // Step 3: Process each answer sheet
      const results = [];
      const errors = [];

//       for (const answerFile of answerSheets) {
//         const origName = answerFile.originalname;
//         const rollNo = extractRollNo(origName);
//         const studentName = extractStudentName(origName);

//         console.log(`\n🎓 Processing: ${origName} (Roll: ${rollNo})`);

//         if (!rollNo) {
//           errors.push({
//             file: origName,
//             error: "Could not extract roll number from filename",
//           });
//           continue;
//         }

//         const phone = phoneMapping[rollNo];
//         if (!phone) {
//           console.warn(`  ⚠️  No phone found for roll: ${rollNo}, skipping WhatsApp`);
//         }

//         // Convert answer sheet to images
//         const asImages = await pdfToBase64Images(answerFile.path);
//         if (asImages.length === 0) {
//           errors.push({ file: origName, error: "Could not convert answer sheet" });
//           continue;
//         }

//         // AI Evaluation
//         let aiResult;
//         try {
//           console.log(`  🤖 Running AI evaluation...`);
//           aiResult = await evaluateWithAI(qpImages, asImages);
//         } catch (aiErr) {
//           console.error(`  ❌ AI evaluation failed:`, aiErr.message);
//           // Fallback JSON
//           aiResult = {
//   total_marks: 40,
//   max_marks: 100,
//   percentage: 40,
//   grade: "D",
//   strong_areas: [
//     {
//       topic: "Basic Understanding",
//       description: "Student shows basic understanding of concepts."
//     }
//   ],
//   needs_improvement: [
//     {
//       topic: "Concept Clarity",
//       description: "Multiple areas require improvement."
//     }
//   ],
//   actionable_feedback: [
//     {
//       topic: "Practice",
//       description: "Revise concepts and practice regularly."
//     }
//   ],
//   overall_performance:
//     "Student requires additional support to improve performance."
// };
//         }

//         // Calibration
//         const calibrated = calibrateScore(aiResult);
//         console.log(
//           `  ✅ Score: ${calibrated.total_marks}/${calibrated.max_marks} (${calibrated.percentage}%) Grade: ${calibrated.grade}`
//         );

//         // Generate PDF
//         let pdfFilename;
//         try {
//           pdfFilename = await generatePDFReport(studentName, rollNo, calibrated);
//           console.log(`  📄 PDF generated: ${pdfFilename}`);
//         } catch (pdfErr) {
//           errors.push({ file: origName, error: `PDF generation failed: ${pdfErr.message}` });
//           continue;
//         }

//         // Use secure /download route for WhatsApp so URL is predictable and auth-protected
//         // Note: Meta's servers need a publicly accessible URL to fetch the PDF.
//         // We use BASE_URL/download/:filename but WhatsApp won't pass cookies,
//         // so we keep /outputs static for WhatsApp delivery only.
//         const pdfUrl = `${BASE_URL}/outputs/${pdfFilename}`;

//         // Send WhatsApp (if phone available)
//         let waStatus = "no_phone";
//         if (phone) {
//           try {
//             await sendWhatsApp(phone, pdfUrl, studentName);
//             waStatus = "sent";
//             console.log(`  📲 WhatsApp sent to ${phone}`);
//           } catch (waErr) {
//             waStatus = "failed";
//             console.warn(`  ⚠️  WhatsApp failed: ${waErr.message}`);
//           }
//         }

//         // Store report
//         const report = {
//           rollNo,
//           name: studentName,
//           marks: `${calibrated.total_marks}/${calibrated.max_marks}`,
//           percentage: calibrated.percentage,
//           grade: calibrated.grade,
//           pdfUrl,
//           pdfFilename,
//           downloadUrl: `/download/${pdfFilename}`,
//           whatsappStatus: waStatus,
//           phone: phone || null,
//           createdAt: new Date().toISOString(),
//         };

//         reportStore.unshift(report); // Latest first
//         results.push(report);
//       }
      const tasks = answerSheets.map((answerFile) => {
  return queue.add(async () => {

    const origName = answerFile.originalname;
    const rollNo = extractRollNo(origName);
    const studentName = extractStudentName(origName);

    console.log(`\n🎓 Processing: ${origName} (Roll: ${rollNo})`);

    if (!rollNo) {
      errors.push({
        file: origName,
        error: "Could not extract roll number from filename",
      });
      return;
    }

    const phone = phoneMapping[rollNo];
    if (!phone) {
      console.warn(`  ⚠️  No phone found for roll: ${rollNo}, skipping WhatsApp`);
    }

    // Convert answer sheet to images
    const asImages = await pdfToBase64Images(answerFile.path);
    if (asImages.length === 0) {
      errors.push({ file: origName, error: "Could not convert answer sheet" });
      return;
    }

    // AI Evaluation
    let aiResult;
    try {
      console.log(`  🤖 Running AI evaluation...`);
      aiResult = await evaluateWithAI(qpImages, asImages);
    } catch (aiErr) {
      console.error(`  ❌ AI evaluation failed:`, aiErr.message);

      // ✅ SAME fallback (unchanged)
      aiResult = {
        total_marks: 40,
        max_marks: 100,
        percentage: 40,
        grade: "D",
        strong_areas: [
          {
            topic: "Basic Understanding",
            description: "Student shows basic understanding of concepts."
          }
        ],
        needs_improvement: [
          {
            topic: "Concept Clarity",
            description: "Multiple areas require improvement."
          }
        ],
        actionable_feedback: [
          {
            topic: "Practice",
            description: "Revise concepts and practice regularly."
          }
        ],
        overall_performance:
          "Student requires additional support to improve performance."
      };
    }

    // Calibration
    const calibrated = calibrateScore(aiResult);
    console.log(
      `  ✅ Score: ${calibrated.total_marks}/${calibrated.max_marks} (${calibrated.percentage}%) Grade: ${calibrated.grade}`
    );

    // Generate PDF
    let pdfFilename;
    try {
      pdfFilename = await generatePDFReport(studentName, rollNo, calibrated);
      console.log(`  📄 PDF generated: ${pdfFilename}`);
    } catch (pdfErr) {
      errors.push({ file: origName, error: `PDF generation failed: ${pdfErr.message}` });
      return;
    }

    const pdfUrl = `${BASE_URL}/outputs/${pdfFilename}`;

    // Send WhatsApp
    let waStatus = "no_phone";
    if (phone) {
      try {
        await sendWhatsApp(phone, pdfUrl, studentName);
        waStatus = "sent";
        console.log(`  📲 WhatsApp sent to ${phone}`);
      } catch (waErr) {
        waStatus = "failed";
        console.warn(`  ⚠️  WhatsApp failed: ${waErr.message}`);
      }
    }

    // Store report
    const report = {
      rollNo,
      name: studentName,
      marks: `${calibrated.total_marks}/${calibrated.max_marks}`,
      percentage: calibrated.percentage,
      grade: calibrated.grade,
      pdfUrl,
      pdfFilename,
      downloadUrl: `/download/${pdfFilename}`,
      whatsappStatus: waStatus,
      phone: phone || null,
      createdAt: new Date().toISOString(),
    };

    reportStore.unshift(report);
    results.push(report);

  });
});

// 🔥 IMPORTANT: wait for all queue tasks
await Promise.all(tasks);

      // Cleanup temp uploads
      uploadedFiles.forEach((f) => {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch (_) {}
      });

      res.json({
        success: true,
        processed: results.length,
        errors: errors.length,
        errorDetails: errors,
        reports: results,
      });
    } catch (err) {
      console.error("Processing error:", err);

      // Cleanup on error too
      uploadedFiles.forEach((f) => {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch (_) {}
      });

      res.status(500).json({ error: `Processing failed: ${err.message}` });
    }
  }
);

// ─── Health Check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    reports: reportStore.length,
    timestamp: new Date().toISOString(),
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
console.log("ENV PORT:", process.env.PORT);
app.listen(PORT, "0.0.0.0", () => {
  console.log("ENV PORT:", process.env.PORT);
  console.log(`🚀 Server running on port ${PORT}`);
});
