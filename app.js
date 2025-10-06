const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

// Ambil argument dari command line
const args = process.argv.slice(2);
const options = {};

// Parse argument --key=value
args.forEach(arg => {
  const [key, value] = arg.split("=");
  if (key && value) {
    options[key.replace(/^--/, "")] = value;
  }
});

const PARALLEL_LIMIT = 5;
const DELAY_MS = 100; // delay antar chunk untuk aman
const API_URL = options.url || "https://antrisimatupang.com";
const CSV_FILE = options.csv || "batch_data.csv";
const tokenPattern = /name="_token"\s+value="([^"]+)"/;

let processedData = [];

// --- HELPERS ---
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readCSV(filePath) {
  const csvPath = path.resolve(filePath);
  if (!fs.existsSync(csvPath)) throw new Error(`File CSV tidak ditemukan: ${csvPath}`);

  const raw = fs.readFileSync(csvPath, "utf-8");
  const records = parse(raw, {
    columns: header => header.map(h => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
  });

  const requiredCols = ["name", "ktp", "phone"];
  const missing = requiredCols.filter(col => !(col in records[0]));
  if (missing.length > 0) throw new Error(`Kolom hilang di CSV: ${missing.join(", ")}`);

  return records;
}

// --- Ambil token CSRF fresh + cookies ---
async function getToken() {
  const resp = await fetch(API_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
    credentials: "include" // penting agar session valid
  });
  const html = await resp.text();
  const match = html.match(tokenPattern);
  if (!match) throw new Error("_token tidak ditemukan");
  return match[1];
}

// --- Ambil captcha (jika diperlukan) ---
async function getCaptcha() {
  try {
    const resp = await fetch(`${API_URL}/reload-captcha`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      credentials: "include",
    });
    const j = await resp.json();
    return j.captcha || "";
  } catch (err) {
    console.log("⚠️ Gagal ambil captcha:", err.message);
    return "";
  }
}

// --- Cek hasil pendaftaran ---
async function checkRegistration(ktp) {
  try {
    const resp = await fetch(`${API_URL}/search?ktp=${ktp}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      credentials: "include",
    });
    const html = await resp.text();

    const info = {
      website: API_URL,
      nomorAntrian: (html.match(/Nomor Antrian\s*:\s*([A-Z0-9\-]+)/) || [])[1] || "N/A",
      ref: (html.match(/Ref\s*:\s*([0-9]+)/) || [])[1] || "N/A",
      namaKTP: (html.match(/Nama KTP\s*:\s*([\w\s]+)/) || [])[1] || "N/A",
      nomorKTP: (html.match(/Nomor KTP\s*:\s*(\*+[\d]+)/) || [])[1] || "N/A",
      nomorHP: (html.match(/Nomor HP\s*:\s*(\*+[\d]+)/) || [])[1] || "N/A",
      tanggalDatang: (html.match(/Tanggal Datang\s*:\s*([\d\-]+)/) || [])[1] || "N/A",
      wajibHadir: (html.match(/Wajib Hadir\s*:\s*([\d\.: -]+)/) || [])[1] || "N/A",
    };

    return `
===== PENDAFTARAN BERHASIL =====
Website        : ${info.website}
Nomor Antrian  : ${info.nomorAntrian}
Ref            : ${info.ref}
Nama KTP       : ${info.namaKTP}
Nomor KTP      : ${info.nomorKTP}
Nomor HP       : ${info.nomorHP}
Tanggal Datang : ${info.tanggalDatang}
Wajib Hadir    : ${info.wajibHadir}
================================
`.trim();
  } catch (err) {
    return `⚠️ Gagal cek search: ${err.message}`;
  }
}

// --- POST DATA ---
async function postData(item) {
  try {
    const token = await getToken();
    const captcha = await getCaptcha();

    const payload = {
      name: item.name,
      ktp: item.ktp.replace(/\D/g, "").slice(0, 16),
      phone_number: item.phone.replace(/\D/g, "").slice(0, 12),
      captcha_input: captcha,
      check: "on",
      check_2: "on",
      _token: token,
    };

    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
      },
      body: new URLSearchParams(payload).toString(),
      credentials: "include",
    });

    const resultText = await resp.text();
    let registrationInfo = "";

    if (resultText.includes("Pendaftaran Berhasil")) {
      registrationInfo = await checkRegistration(payload.ktp);
    }

    return { ...payload, status: "OK", resultSnippet: resultText, registrationInfo };
  } catch (err) {
    return { ...item, status: "ERROR", error_message: err.message, registrationInfo: "" };
  }
}

// --- SIMPAN HASIL ---
function saveResults(data) {
  if (!data.length) return;

  const allKeys = new Set();
  data.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));
  const headers = Array.from(allKeys);

  // JSON
  fs.writeFileSync("processedData.json", JSON.stringify(data, null, 2));
  console.log("✅ Semua data disimpan ke processedData.json");

  // CSV
  const csv = data.map(r => headers.map(h => {
    let val = r[h] !== undefined ? String(r[h]) : "";
    val = val.replace(/"/g, '""').replace(/\r?\n/g, "\\n");
    return `"${val}"`;
  }).join(",")).join("\n");

  fs.writeFileSync("processedData.csv", headers.join(",") + "\n" + csv);
  console.log("✅ CSV hasil disimpan ke processedData.csv");
}

// --- MAIN BATCH ---
async function runBatch() {
  console.log("🚀 Mulai batch...");

  const startTime = Date.now();
  const batchData = readCSV(CSV_FILE);
  console.log(`📋 Membaca ${batchData.length} data dari ${CSV_FILE}`);

  for (let i = 0; i < batchData.length; i += PARALLEL_LIMIT) {
    const chunk = batchData.slice(i, i + PARALLEL_LIMIT);
    const promises = chunk.map(item => postData(item));
    const results = await Promise.all(promises);
    processedData.push(...results);

    results.forEach((r, idx) => {
      console.log(`\n📌 Item ${i + idx + 1} - ${r.name || r.ktp} - Status: ${r.status}`);
      if (r.status === "OK" && r.registrationInfo) console.log(r.registrationInfo);
      if (r.status === "ERROR") console.log(`⚠️ Error: ${r.error_message}`);
    });

    await delay(DELAY_MS);
  }

  saveResults(processedData);
  const durasi = (Date.now() - startTime) / 1000;
  console.log(`\n⏱️ Selesai dalam ${durasi.toFixed(2)} detik`);
}


// ======= VARIABEL JAM DINAMIS =======
const SCHEDULE_HOUR = parseInt(options.hour) || 15; // example default 15 = jam 3 sore
const SCHEDULE_MINUTE = parseInt(options.minute) || 0; // example default 0 = menit 0
const SCHEDULE_SECOND = parseInt(options.second) || 0; // example default 0 = detik 0

// ======= HITUNG DELAY MS KE WAKTU TARGET =======
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

  // Kalau target sudah lewat hari ini, jadwalkan besok
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  return target - now; // dalam ms
}

// ======= SCHEDULE BATCH OTOMATIS =======
async function scheduleBatch() {
  let delayMs = getDelayToTime(SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_SECOND);

  setInterval(() => {
    // Konversi detik ke jam, menit, detik
    delayMs = getDelayToTime(SCHEDULE_HOUR, SCHEDULE_MINUTE, SCHEDULE_SECOND);
    const hours = Math.floor(delayMs / 3600000);
    const minutes = Math.floor((delayMs % 3600000) / 60000);
    const seconds = Math.floor((delayMs % 60000) / 1000);
    process.stdout.write(
      `\r🕒 Menunggu batch berikutnya pada ${delayMs} ms → ${hours} jam ${minutes} menit ${seconds} detik`
    );
  }, 1000);

  console.log(`🕒 [${API_URL}] Batch dijadwalkan pukul ${SCHEDULE_HOUR}:${SCHEDULE_MINUTE}:${SCHEDULE_SECOND} (delay ${Math.round(delayMs / 1000)} detik)`);

  setTimeout(async () => {
    console.log(`\n⏰ Waktu batch tiba! Mulai runBatch()`);
    await runBatch().catch((err) => console.error("🚨 Error batch:", err));

    // Setelah selesai, schedule batch besok pada jam yang sama
    scheduleBatch();
  }, delayMs);
}

// ======= JALANKAN SCHEDULER =======
scheduleBatch();
// runBatch().catch((err) => console.error("🚨 Error batch:", err));
