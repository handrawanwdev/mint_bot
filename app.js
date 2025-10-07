const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const dns = require("dns").promises;

// ==========================
// ⚙️ CONFIG & CLI
// ==========================
const args = process.argv.slice(2);
const options = {};
args.forEach((arg) => {
  const [k, v] = arg.split("=");
  if (k && v) options[k.replace(/^--/, "")] = v;
});

const ERROR_DIR = path.join(__dirname, "errors");
const ERROR_LOG = path.join(__dirname, "errors.log");
const API_URL = options.url || "https://antrisimatupang.com";
const CSV_FILE = options.csv || "batch_data.csv";
const PARALLEL_LIMIT = 3;
const DELAY_MS = 500;
const MAX_RETRY = 5;
const RETRY_DELAY = 3000;
const MAX_BACKOFF = 10000;
let retryFailCount = 0;
const MAX_TOTAL_FAIL = 20;

if (!fs.existsSync(ERROR_DIR)) fs.mkdirSync(ERROR_DIR);
if (!fs.existsSync(ERROR_LOG))
  fs.writeFileSync(ERROR_LOG, "timestamp,ktp,name,error_message\n");

let isRunning = false;
let processedData = [];

// ==========================
// 🕒 HELPERS
// ==========================
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const pad = (n) => n.toString().padStart(2, "0");
const timestamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// Cek koneksi internet
async function isOnline() {
  try {
    await dns.resolve("google.com");
    return true;
  } catch {
    return false;
  }
}

// Cek status server
async function isServerUp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(API_URL, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (err) {
    console.warn("⚠️ Gagal cek server:", err.name, err.message);
    return false;
  }
}

async function waitUntilServerUp(retryDelay = 5000) {
  while (true) {
    const online = await isOnline();
    if (!online) {
      console.log("⚠️ Tidak ada koneksi internet, tunggu koneksi...");
      await delay(retryDelay);
      continue;
    }

    const serverUp = await isServerUp();
    if (serverUp) {
      // console.log("🟢 Server up, lanjut eksekusi...");
      return;
    }

    console.log(`🔴 Server masih down, ulangi cek dalam ${retryDelay / 1000} detik...`);
    await delay(retryDelay + Math.random() * 2000);
  }
}

// ==========================
// 🔁 FETCH DENGAN RETRY
// ==========================
// async function safeFetch(url, opts) {
//   try {
//     return await fetchWithRetry(url, opts);
//   } catch (err) {
//     retryFailCount++;
//     if (retryFailCount >= MAX_TOTAL_FAIL) {
//       console.error("🛑 Terlalu banyak kegagalan fetch, hentikan batch sementara");
//       process.exit(1);
//     }
//     throw err;
//   }
// }

async function fetchWithRetry(url, opts = {}, retryCount = MAX_RETRY) {
  let delayMs = RETRY_DELAY;

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    if (!(await isOnline())) {
      console.warn(`⚠️ [${attempt}/${retryCount}] Offline, tunggu 5 detik...`);
      await delay(5000);
      continue;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      console.warn(`❌ [${attempt}/${retryCount}] ${err.message}`);
      if (attempt < retryCount) {
        console.log(`⏳ Retry dalam ${delayMs / 1000}s...`);
        await delay(delayMs);
        delayMs = Math.min(delayMs * 1.5, MAX_BACKOFF);
      } else {
        throw new Error(
          `Gagal fetch setelah ${retryCount} percobaan: ${err.message}`
        );
      }
    }
  }
}

// ==========================
// 📂 CSV READER
// ==========================
function readCSV(file) {
  if (!fs.existsSync(file)) throw new Error(`CSV tidak ditemukan: ${file}`);
  const raw = fs.readFileSync(file, "utf-8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  const required = ["name", "ktp", "phone"];
  const missing = required.filter((c) => !(c in records[0]));
  if (missing.length) throw new Error(`Kolom hilang: ${missing.join(", ")}`);
  return records;
}

function checkCSVFile(file) {
  try {
    const data = readCSV(file);
    if (!data.length) {
      console.log(`📄 File ${file} kosong. Silakan isi data.`);
      process.exit(0);
    }
    console.log(`✅ File ${file} valid dengan ${data.length} baris data.`);
  } catch (err) {
    console.error(`🚨 Error baca CSV: ${err.message}`);
    process.exit(1);
  }
}

checkCSVFile(CSV_FILE);

// ==========================
// 🔐 TOKEN & CAPTCHA
// ==========================
async function getTokenAndCaptcha() {
  const res = await fetchWithRetry(API_URL, { method: "GET", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36" } });
  const html = await res.text();
  // Ambil _token
  const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error("_token tidak ditemukan");
  const token = tokenMatch[1];

  // Ambil captcha dari <div id="captcha-box">...</div>
  const captchaMatch = html.match(
    /<div[^>]+id=["']captcha-box["'][^>]*>([\s\S]*?)<\/div>/i
  );
  const captcha = captchaMatch
    ? captchaMatch[1].replace(/[\s\r\n]+/g, "").trim()
    : null;

  if (!captcha) console.warn("⚠️ Captcha tidak ditemukan di halaman utama.");

  return { token, captcha };
}

// async function getCaptcha() {
//   try {
//     const res = await safeFetch(`${API_URL}/reload-captcha`);
//     const j = await res.json();
//     return j.captcha || "";
//   } catch (err) {
//     console.log("⚠️ Gagal ambil captcha:", err.message);
//     return "";
//   }
// }

// ==========================
// 📤 POST DATA
// ==========================
async function postData(item, attempt = 1) {
  try {
    await waitUntilServerUp();

    const { token, captcha } = await getTokenAndCaptcha();

    const payload = {
      name: item.name,
      ktp: item.ktp.replace(/\D/g, "").slice(0, 16),
      phone_number: item.phone.replace(/\D/g, "").slice(0, 12),
      captcha_input: captcha,
      check: "on",
      check_2: "on",
      _token: token,
    };

    const res = await fetchWithRetry(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36" },
      body: new URLSearchParams(payload).toString(),
    });

    const html = await res.text();

    if (html.includes("Page Expired") || html.includes("419")) {
      if (attempt >= 3) return { ...payload, status: "ERROR", error_message: "Token kadaluarsa terus menerus" };
      console.warn("⚠️ Token kadaluarsa, retry 1x...");
      await delay(1000 + Math.random() * 2000); // jeda kecil antar retry
      return await postData(item, attempt + 1);
    }

    if (html.includes("Pendaftaran Berhasil")) {
      return { ...payload, status: "OK", info: "Pendaftaran berhasil" };
    }

    const errMatch = html.match(
      /<div class="alert alert-danger"[^>]*>([\s\S]*?)<\/div>/
    );
    const errMsg = errMatch
      ? errMatch[1].replace(/<[^>]+>/g, "").trim()
      : "Error tidak diketahui";
    const errFile = path.join(
      ERROR_DIR,
      `error_${payload.ktp}_${Date.now()}.html`
    );
    fs.writeFileSync(errFile, html);

    return { ...payload, status: "ERROR", error_message: errMsg };
  } catch (err) {
    fs.appendFileSync(
      ERROR_LOG,
      `[${timestamp()}] ${item.ktp}|${item.name}|${err.message}\n`
    );
    return { ...item, status: "ERROR", error_message: err.message };
  }
}

// ==========================
// 💾 SAVE RESULT
// ==========================
function saveResults(data) {
  if (!data.length) return;
  fs.writeFileSync("processedData.json", JSON.stringify(data, null, 2));
  const headers = Object.keys(data[0]);
  const csv = data
    .map((d) =>
      headers
        .map((h) => `"${(d[h] ?? "").toString().replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");
  const okCount = data.filter(d => d.status === "OK").length;
  const errCount = data.filter(d => d.status === "ERROR").length;
  console.log(`✅ Selesai: ${okCount} sukses, ${errCount} gagal`);

  fs.writeFileSync("processedData.csv", headers.join(",") + "\n" + csv);
  console.log("✅ Hasil disimpan ke processedData.csv dan processedData.json");
}

// ==========================
// 🧩 MAIN EXECUTION
// ==========================
async function runBatch() {
  console.log("🚀 Mulai batch...");
  isRunning = true;
  const start = Date.now();

  const data = readCSV(CSV_FILE);
  console.log(`📋 ${data.length} data dibaca`);

  for (let i = 0; i < data.length; i += PARALLEL_LIMIT) {
    const timeStart = Date.now();
    const chunk = data.slice(i, i + PARALLEL_LIMIT);
    const results = await Promise.all(chunk.map(postData));
    processedData.push(...results);
    await delay(DELAY_MS + Math.random() * 500);
    console.log(`🔄 Proses ${i} s.d ${Math.min(i + PARALLEL_LIMIT, data.length)} dari ${data.length}`);
    const timeTaken = (Date.now() - timeStart) / 1000;
    console.log(`   ⏱️ Waktu chunk: ${timeTaken.toFixed(2)}s`);
  }

  saveResults(processedData);
  console.log(`⏱️ Selesai dalam ${(Date.now() - start) / 1000}s`);
  isRunning = false;
}

// ==========================
// ⏰ SCHEDULER
// ==========================
const SCHEDULE_HOUR = parseInt(options.hour) || 15;
const SCHEDULE_MINUTE = parseInt(options.minute) || 0;
const SCHEDULE_SECOND = parseInt(options.second) || 0;

function getDelayToTime(hour, minute = 0, second = 0) {
  const now = new Date();
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    second
  );
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

async function scheduleBatch() {
  let delayMs = getDelayToTime(SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_SECOND);
  console.log(
    `🕒 [${API_URL}] Batch dijadwalkan pukul ${SCHEDULE_HOUR}:${SCHEDULE_MINUTE}:${SCHEDULE_SECOND} (delay ${Math.round(
      delayMs / 1000
    )} detik)`
  );

  setInterval(async () => {
    delayMs = getDelayToTime(SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_SECOND);
    const hours = Math.floor(delayMs / 3600000);
    const minutes = Math.floor((delayMs % 3600000) / 60000);
    const seconds = Math.floor((delayMs % 60000) / 1000);

    if (!isRunning) {
      process.stdout.write(
        `\r🕒 Menunggu batch berikutnya → ${hours} jam ${minutes} menit ${seconds} detik`
      );
    }

    if (hours === 0 && minutes === 0 && seconds === 0 && !isRunning) {
      console.log("\n⏰ Waktu batch tiba! Mulai runBatch()");
      await runBatch().catch((err) => console.error("🚨 Error batch:", err));
    }
  }, 1000);
}

// ==========================
// ▶️ JALANKAN
// ==========================
// scheduleBatch();
runBatch().catch((err) => console.error("🚨 Error batch:", err));
