// ═══════════════════════════════════════════════════════════════════
//  CALL LEDGER — Cloudflare Worker
//  GHL Webhook → GHL API (recording) → Whisper → Claude → Google Sheets
// ═══════════════════════════════════════════════════════════════════
//
//  Required secrets (set in Cloudflare dashboard under Worker > Settings > Variables & Secrets):
//    GHL_API_KEY         — Your GHL API key
//    GHL_LOCATION_ID     — Your GHL sub-account location ID
//    ANTHROPIC_API_KEY   — From console.anthropic.com
//    OPENAI_API_KEY      — From platform.openai.com
//    GOOGLE_SERVICE_ACCOUNT_EMAIL — The service account email
//    GOOGLE_PRIVATE_KEY  — The private key from the JSON (the full -----BEGIN... block)
//    GOOGLE_SHEET_ID     — The ID from your Google Sheet URL
//
//  Environment variables (non-secret, set in dashboard or wrangler.toml):
//    LEDGER_SHEET_NAME   — Default: "Call Ledger"
//    FIRST_DATA_ROW      — Default: 5
// ═══════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // GET = health check
    if (request.method === "GET") {
      return json({ status: "ok", message: "Call Ledger worker is active" });
    }

    // POST = webhook from GHL
    if (request.method === "POST") {
      try {
        const payload = await request.json();
        console.log("Webhook received:", JSON.stringify(payload).substring(0, 500));

        const result = await processCall(payload, env);
        return json(result);
      } catch (err) {
        console.error("Worker error:", err.message, err.stack);
        return json({ status: "error", message: err.message }, 500);
      }
    }

    return json({ status: "error", message: "Method not allowed" }, 405);
  },
};


// ═══════════════════════════════════════════════════════════════════
//  MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════════

async function processCall(payload, env) {
  // Step 1: Extract contact info from webhook
  const contactInfo = extractContactInfo(payload);
  console.log("Contact info:", JSON.stringify(contactInfo));

  if (!contactInfo.contactId) {
    console.log("No contact ID — writing basic info only");
    await writeToSheet(env, contactInfo, "", {});
    return { status: "partial", reason: "No contact ID for API lookup", seller: contactInfo.sellerName };
  }

  // Step 2: Fetch full contact details + recording URL from GHL API
  const ghlData = await fetchGHLCallData(contactInfo.contactId, env);
  const callData = mergeCallData(contactInfo, ghlData);
  console.log("Merged call data:", JSON.stringify({ ...callData, recordingUrl: callData.recordingUrl ? "FOUND" : "NONE" }));

  // Step 3: Transcribe recording with Whisper
  let transcript = "";
  if (callData.recordingUrl) {
    console.log("Transcribing recording...");
    transcript = await transcribeRecording(callData.recordingUrl, env);
    console.log("Transcript length:", transcript.length);
  } else {
    console.log("No recording URL found — skipping transcription");
  }

  // Step 4: Extract details with Claude
  let aiExtracted = {};
  if (transcript) {
    console.log("Sending to Claude for extraction...");
    aiExtracted = await extractCallDetails(transcript, callData, env);
    console.log("AI extracted:", JSON.stringify(aiExtracted));
  }

  // Step 5: Write to Google Sheet
  await writeToSheet(env, callData, transcript, aiExtracted);

  return { status: "success", seller: callData.sellerName, hasTranscript: !!transcript, hasSummary: !!aiExtracted.call_summary };
}


// ═══════════════════════════════════════════════════════════════════
//  EXTRACT CONTACT INFO FROM WEBHOOK
// ═══════════════════════════════════════════════════════════════════

function extractContactInfo(payload) {
  const contact = payload.contact || payload.Contact || payload;

  const contactId = contact.id || contact.contactId || contact.contact_id ||
                    payload.contactId || payload.contact_id || "";

  const firstName = contact.firstName || contact.first_name || contact.name || "";
  const lastName = contact.lastName || contact.last_name || "";
  const sellerName = (firstName + " " + lastName).trim() || "Unknown Seller";
  const phone = contact.phone || contact.phoneNumber || contact.phone_number || "";

  const callDate = payload.dateAdded || payload.date_added || payload.timestamp ||
                   contact.dateAdded || new Date().toISOString();

  return {
    contactId,
    sellerName,
    phone,
    callDate: new Date(callDate).toISOString(),
    propertyAddress: "",
    cityState: "",
    askingPrice: "",
    propertyType: "",
    recordingUrl: "",
  };
}


// ═══════════════════════════════════════════════════════════════════
//  GHL API — Fetch contact + recording
// ═══════════════════════════════════════════════════════════════════

const GHL_API_BASE = "https://services.leadconnectorhq.com";

async function fetchGHLCallData(contactId, env) {
  const result = {
    sellerName: "", phone: "", propertyAddress: "", cityState: "",
    askingPrice: "", propertyType: "", recordingUrl: "",
  };

  const headers = {
    "Authorization": "Bearer " + env.GHL_API_KEY,
    "Version": "2021-07-28",
  };

  // 1. Get contact details
  try {
    const resp = await fetch(`${GHL_API_BASE}/contacts/${contactId}`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      const c = data.contact || data;

      result.sellerName = ((c.firstName || "") + " " + (c.lastName || "")).trim();
      result.phone = c.phone || "";

      const cf = c.customFields || c.customField || [];
      result.propertyAddress = getCustomField(cf, ["property_address", "address", "Property Address"]);
      result.cityState = getCustomField(cf, ["city_state", "city", "City / State", "City State"]);
      result.askingPrice = getCustomField(cf, ["asking_price", "price", "Asking Price"]);
      result.propertyType = getCustomField(cf, ["property_type", "Property Type"]);

      console.log("GHL contact fetched:", result.sellerName);
    } else {
      const errText = await resp.text();
      console.error("GHL contact error:", resp.status, errText.substring(0, 300));
    }
  } catch (err) {
    console.error("GHL contact fetch failed:", err.message);
  }

  // 2. Search conversations for recording URL
  try {
    const convResp = await fetch(
      `${GHL_API_BASE}/conversations/search?contactId=${contactId}&locationId=${env.GHL_LOCATION_ID}`,
      { headers }
    );

    if (convResp.ok) {
      const convData = await convResp.json();
      const conversations = convData.conversations || [];

      for (const conv of conversations) {
        if (result.recordingUrl) break;

        const msgResp = await fetch(
          `${GHL_API_BASE}/conversations/${conv.id}/messages?limit=20`,
          { headers }
        );

        if (msgResp.ok) {
          const msgData = await msgResp.json();
          console.log("GHL messages response keys:", Object.keys(msgData));
          console.log("GHL messages raw (first 500):", JSON.stringify(msgData).substring(0, 500));

          // Handle various response structures
          let messages = [];
          if (Array.isArray(msgData.messages)) {
            messages = msgData.messages;
          } else if (Array.isArray(msgData.data)) {
            messages = msgData.data;
          } else if (Array.isArray(msgData)) {
            messages = msgData;
          } else if (msgData.messages && typeof msgData.messages === "object") {
            // Might be paginated or nested differently
            messages = Object.values(msgData.messages);
          }

          console.log("Parsed messages count:", messages.length);

          for (const msg of messages) {
            if (!msg || typeof msg !== "object") continue;

            const msgType = (msg.type || msg.messageType || msg.contentType || "").toLowerCase();
            const msgBody = (msg.body || msg.message || msg.text || "").toLowerCase();
            const isCall = msgType.includes("call") || !!msg.call || !!msg.callId ||
                          msgBody.includes("call") || msgType.includes("audio");

            // Also check for recording URLs in any field
            const recording = msg.recordingUrl || msg.recording_url ||
                             msg.meta?.recordingUrl || msg.meta?.recording_url ||
                             msg.attachments?.[0]?.url ||
                             (msg.call && msg.call.recordingUrl) ||
                             msg.mediaUrl || msg.media_url || "";

            // Check if any URL in the message looks like a recording
            const bodyUrl = (msg.body || "").match(/(https:\/\/storage\.googleapis\.com\/[^\s"]+\.mp3)/);

            if (recording) {
              result.recordingUrl = recording;
              console.log("Found recording via field:", recording.substring(0, 100));
              break;
            } else if (bodyUrl) {
              result.recordingUrl = bodyUrl[1];
              console.log("Found recording in message body:", bodyUrl[1].substring(0, 100));
              break;
            }
          }
        } else {
          const errText = await msgResp.text();
          console.error("GHL messages error:", msgResp.status, errText.substring(0, 300));
        }
      }
    }

    if (!result.recordingUrl) {
      console.log("No recording URL found in GHL conversations");
    }
  } catch (err) {
    console.error("GHL conversation search failed:", err.message);
  }

  return result;
}

function getCustomField(customFields, possibleKeys) {
  if (Array.isArray(customFields)) {
    for (const field of customFields) {
      const fKey = (field.id || field.key || field.name || field.fieldKey || "").toLowerCase();
      const fName = (field.name || field.fieldName || "").toLowerCase();
      for (const key of possibleKeys) {
        if (fKey === key.toLowerCase() || fName === key.toLowerCase()) {
          return field.value || field.fieldValue || "";
        }
      }
    }
  } else if (typeof customFields === "object" && customFields !== null) {
    for (const key of possibleKeys) {
      for (const k of Object.keys(customFields)) {
        if (k.toLowerCase() === key.toLowerCase()) return customFields[k];
      }
    }
  }
  return "";
}

function mergeCallData(webhookData, apiData) {
  return {
    contactId: webhookData.contactId,
    sellerName: apiData.sellerName || webhookData.sellerName,
    phone: apiData.phone || webhookData.phone,
    callDate: webhookData.callDate,
    propertyAddress: apiData.propertyAddress || webhookData.propertyAddress,
    cityState: apiData.cityState || webhookData.cityState,
    askingPrice: apiData.askingPrice || webhookData.askingPrice,
    propertyType: apiData.propertyType || webhookData.propertyType,
    recordingUrl: apiData.recordingUrl || webhookData.recordingUrl,
  };
}


// ═══════════════════════════════════════════════════════════════════
//  TRANSCRIPTION — OpenAI Whisper
// ═══════════════════════════════════════════════════════════════════

async function transcribeRecording(recordingUrl, env) {
  try {
    // Download the audio
    const audioResp = await fetch(recordingUrl);
    if (!audioResp.ok) {
      console.error("Failed to download recording:", audioResp.status);
      return "";
    }

    const audioBuffer = await audioResp.arrayBuffer();
    const sizeMB = audioBuffer.byteLength / (1024 * 1024);
    console.log(`Recording size: ${sizeMB.toFixed(1)}MB`);

    if (sizeMB > 25) {
      console.error("Recording too large for Whisper (25MB limit)");
      return "";
    }

    // Determine filename from content-type
    const contentType = audioResp.headers.get("content-type") || "audio/mpeg";
    let ext = "mp3";
    if (contentType.includes("wav")) ext = "wav";
    else if (contentType.includes("mp4") || contentType.includes("m4a")) ext = "m4a";
    else if (contentType.includes("ogg")) ext = "ogg";

    // Build multipart form data
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: contentType }), `recording.${ext}`);
    formData.append("model", "whisper-1");
    formData.append("response_format", "text");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY },
      body: formData,
    });

    if (resp.ok) {
      const transcript = await resp.text();
      console.log("Whisper transcription done:", transcript.substring(0, 150) + "...");
      return transcript;
    } else {
      const err = await resp.text();
      console.error("Whisper error:", err.substring(0, 300));
      return "";
    }
  } catch (err) {
    console.error("Transcription failed:", err.message);
    return "";
  }
}


// ═══════════════════════════════════════════════════════════════════
//  AI EXTRACTION — Claude
// ═══════════════════════════════════════════════════════════════════

async function extractCallDetails(transcript, callData, env) {
  try {
    const prompt = `You are analyzing a phone call transcript between a real estate acquisitions team (Summit Group Acquisitions) and a property seller. Extract the following details from the transcript. If a detail is not mentioned, leave that field as an empty string.

Return ONLY a valid JSON object with these exact keys:
{
  "property_address": "",
  "city_state": "",
  "asking_price": "",
  "property_type": "SFR|Multi-Family|Commercial|Land|Mobile Home|Condo/Townhouse|Other",
  "motivation_level": "Hot|Warm|Cold|Not Interested",
  "call_summary": "2-3 sentence summary of the conversation — what was discussed, what the seller wants, and any key takeaways",
  "next_steps": "specific action items and follow-up tasks from this call",
  "callback_date": "MM/DD/YYYY format, or empty if no specific callback was scheduled"
}

Motivation level guide:
- Hot: Seller is eager, wants to move fast, has a deadline, or is very cooperative
- Warm: Seller is interested but not urgent, needs to think about it, or wants to compare offers
- Cold: Seller is hesitant, gave minimal info, seems unlikely to sell soon
- Not Interested: Seller explicitly declined or said they are not selling

Known info about the seller:
- Name: ${callData.sellerName}
- Phone: ${callData.phone}
- Known property address: ${callData.propertyAddress || "Unknown"}

TRANSCRIPT:
${transcript}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (resp.ok) {
      const result = await resp.json();
      const text = result.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } else {
      const err = await resp.text();
      console.error("Claude error:", err.substring(0, 300));
    }
    return {};
  } catch (err) {
    console.error("AI extraction failed:", err.message);
    return {};
  }
}


// ═══════════════════════════════════════════════════════════════════
//  GOOGLE SHEETS — Write via Sheets API with Service Account
// ═══════════════════════════════════════════════════════════════════

async function writeToSheet(env, callData, transcript, aiExtracted) {
  const sheetName = env.LEDGER_SHEET_NAME || "Call Ledger";
  const firstDataRow = parseInt(env.FIRST_DATA_ROW || "5");

  // Get access token via service account JWT
  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) {
    console.error("Failed to get Google access token");
    return;
  }

  const sheetId = env.GOOGLE_SHEET_ID;
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;

  // Find the next empty row by reading column B
  const rangeResp = await fetch(
    `${baseUrl}/values/${encodeURIComponent(sheetName)}!B${firstDataRow}:B1000`,
    { headers: { "Authorization": "Bearer " + accessToken } }
  );

  let nextRow = firstDataRow;
  if (rangeResp.ok) {
    const rangeData = await rangeResp.json();
    const values = rangeData.values || [];
    nextRow = firstDataRow + values.length;
    // Check for gaps
    for (let i = 0; i < values.length; i++) {
      if (!values[i] || !values[i][0]) {
        nextRow = firstDataRow + i;
        break;
      }
    }
  }

  // Merge AI data with GHL data
  const address = aiExtracted.property_address || callData.propertyAddress || "";
  const cityState = aiExtracted.city_state || callData.cityState || "";
  const askingPrice = aiExtracted.asking_price || callData.askingPrice || "";
  const propType = aiExtracted.property_type || callData.propertyType || "";
  const motivation = aiExtracted.motivation_level || "";
  const summary = aiExtracted.call_summary || "";
  const nextSteps = aiExtracted.next_steps || "";
  const callbackDate = aiExtracted.callback_date || "";

  // Parse asking price as number
  let priceValue = askingPrice;
  const priceNum = parseFloat(String(askingPrice).replace(/[$,]/g, ""));
  if (!isNaN(priceNum)) priceValue = priceNum;

  // Format the date
  const callDate = new Date(callData.callDate);
  const dateStr = `${(callDate.getMonth() + 1).toString().padStart(2, "0")}/${callDate.getDate().toString().padStart(2, "0")}/${callDate.getFullYear()}`;

  // Write row: B through L (A has auto-number formula)
  const rowValues = [
    dateStr,              // B: Date
    callData.sellerName,  // C: Seller Name
    callData.phone,       // D: Phone
    address,              // E: Property Address
    cityState,            // F: City / State
    priceValue,           // G: Asking Price
    propType,             // H: Property Type
    motivation,           // I: Motivation Level
    summary,              // J: Call Summary
    nextSteps,            // K: Next Steps
    callbackDate,         // L: Callback Date
  ];

  const writeRange = `${sheetName}!B${nextRow}:L${nextRow}`;
  const writeResp = await fetch(
    `${baseUrl}/values/${encodeURIComponent(writeRange)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [rowValues] }),
    }
  );

  if (writeResp.ok) {
    console.log(`Row ${nextRow} written for: ${callData.sellerName}`);
  } else {
    const err = await writeResp.text();
    console.error("Sheets write error:", err);
  }
}


// ═══════════════════════════════════════════════════════════════════
//  GOOGLE AUTH — JWT → Access Token
// ═══════════════════════════════════════════════════════════════════

async function getGoogleAccessToken(env) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claimSet = {
      iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    };

    const encodedHeader = base64url(JSON.stringify(header));
    const encodedClaim = base64url(JSON.stringify(claimSet));
    const signInput = `${encodedHeader}.${encodedClaim}`;

    // Import the private key
    const privateKey = await importPrivateKey(env.GOOGLE_PRIVATE_KEY);

    // Sign the JWT
    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      privateKey,
      new TextEncoder().encode(signInput)
    );

    const encodedSignature = base64url(signature);
    const jwt = `${signInput}.${encodedSignature}`;

    // Exchange JWT for access token
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (tokenResp.ok) {
      const tokenData = await tokenResp.json();
      return tokenData.access_token;
    } else {
      const err = await tokenResp.text();
      console.error("Google token error:", err);
      return null;
    }
  } catch (err) {
    console.error("Google auth failed:", err.message);
    return null;
  }
}

async function importPrivateKey(pemKey) {
  // Handle escaped newlines from environment variable
  const pem = pemKey.replace(/\\n/g, "\n");
  const pemContents = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function base64url(input) {
  let str;
  if (typeof input === "string") {
    str = btoa(input);
  } else {
    // ArrayBuffer
    str = btoa(String.fromCharCode(...new Uint8Array(input)));
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}


// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
