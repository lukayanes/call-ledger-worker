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
  // ── HTTP handler: receives GHL webhook and queues the job ──
  async fetch(request, env, ctx) {
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
        console.log("Webhook received — queuing job:", JSON.stringify(payload).substring(0, 500));

        // Drop the job onto the queue — responds to GHL instantly
        await env.CALL_QUEUE.send(payload);
        return json({ status: "queued", message: "Call processing queued" });
      } catch (err) {
        console.error("Worker error:", err.message, err.stack);
        return json({ status: "error", message: err.message }, 500);
      }
    }

    return json({ status: "error", message: "Method not allowed" }, 405);
  },

  // ── Queue consumer: processes calls with no time pressure ──
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const payload = message.body;
        console.log("Processing queued call:", JSON.stringify(payload).substring(0, 300));

        await processCall(payload, env);
        message.ack();
        console.log("Queue message processed and acknowledged");
      } catch (err) {
        console.error("Queue processing error:", err.message, err.stack);
        message.retry();
      }
    }
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

  // Step 4: Read historical call data for coaching context
  let historicalContext = "";
  if (transcript) {
    try {
      console.log("Reading historical call data for coaching...");
      historicalContext = await buildCoachingContext(env);
      console.log("Coaching context length:", historicalContext.length);
    } catch (err) {
      console.error("Historical data read failed (non-fatal):", err.message);
    }
  }

  // Step 5: Extract details with Claude (now with coaching context)
  let aiExtracted = {};
  if (transcript) {
    console.log("Sending to Claude for extraction + coaching...");
    aiExtracted = await extractCallDetails(transcript, callData, env, historicalContext);
    console.log("AI extracted:", JSON.stringify(aiExtracted));
  }

  // Step 6: Write to Call Ledger sheet
  await writeToSheet(env, callData, transcript, aiExtracted);

  // Step 7: Write structured data to Intelligence DB tab
  if (transcript && Object.keys(aiExtracted).length > 0) {
    try {
      await writeToIntelligenceDB(env, callData, aiExtracted);
    } catch (err) {
      console.error("Intelligence DB write failed (non-fatal):", err.message);
    }
  }

  // Step 8: Push call summary + coaching back to GHL contact notes
  if (aiExtracted.call_summary && callData.contactId) {
    await updateGHLContactNotes(callData.contactId, callData, aiExtracted, env);
  }

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
  const rawPhone = contact.phone || contact.phoneNumber || contact.phone_number || "";
  console.log("Raw phone from webhook:", rawPhone);
  const phone = formatPhone(rawPhone);
  console.log("Formatted phone:", phone);

  // Address fields from webhook (GHL custom values)
  const address1 = contact.address1 || contact.streetAddress || contact.street_address || "";
  const city = contact.city || "";
  const state = contact.state || "";
  const postalCode = contact.postal_code || contact.postalCode || "";
  const propertyAddress = address1;
  const cityState = [city, state].filter(Boolean).join(", ") + (postalCode ? " " + postalCode : "");

  const callDate = payload.dateAdded || payload.date_added || payload.timestamp ||
                   contact.dateAdded || new Date().toISOString();

  return {
    contactId,
    sellerName,
    phone,
    callDate: new Date(callDate).toISOString(),
    propertyAddress,
    cityState: cityState.trim(),
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
      result.phone = formatPhone(c.phone || "");

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

        // Paginate through messages to find the most recent recording
        let lastMessageId = null;
        const MAX_PAGES = 5; // Check up to 100 messages (5 pages x 20)

        for (let page = 0; page < MAX_PAGES; page++) {
          if (result.recordingUrl) break;

          let msgUrl = `${GHL_API_BASE}/conversations/${conv.id}/messages?limit=20`;
          if (lastMessageId) {
            msgUrl += `&lastMessageId=${lastMessageId}`;
          }

          const msgResp = await fetch(msgUrl, { headers });

          if (!msgResp.ok) {
            const errText = await msgResp.text();
            console.error("GHL messages error:", msgResp.status, errText.substring(0, 300));
            break;
          }

          const msgData = await msgResp.json();
          if (page === 0) {
            console.log("GHL messages raw (first 500):", JSON.stringify(msgData).substring(0, 500));
          }

          // GHL returns: { messages: { lastMessageId, nextPage, messages: [...] } }
          const msgContainer = msgData.messages || msgData;
          let messages = [];
          if (msgContainer && Array.isArray(msgContainer.messages)) {
            messages = msgContainer.messages;
          } else if (Array.isArray(msgData.messages)) {
            messages = msgData.messages;
          } else if (Array.isArray(msgData.data)) {
            messages = msgData.data;
          } else if (Array.isArray(msgData)) {
            messages = msgData;
          }

          console.log(`Page ${page + 1}: ${messages.length} messages`);

          if (messages.length === 0) break;

          for (const msg of messages) {
            if (!msg || typeof msg !== "object") continue;

            // Check attachments array — GHL puts recording URLs here as strings
            const attachments = msg.attachments || [];
            for (const att of attachments) {
              const url = typeof att === "string" ? att : (att.url || att.href || "");
              if (url && url.includes(".mp3")) {
                result.recordingUrl = url;
                console.log("Found recording in attachments (page " + (page + 1) + "):", url.substring(0, 100));
                break;
              }
            }
            if (result.recordingUrl) break;

            // Also check dedicated recording fields
            const recording = msg.recordingUrl || msg.recording_url ||
                             msg.meta?.recordingUrl || msg.meta?.recording_url ||
                             (msg.call && msg.call.recordingUrl) ||
                             msg.mediaUrl || msg.media_url || "";

            if (recording) {
              result.recordingUrl = recording;
              console.log("Found recording via field (page " + (page + 1) + "):", recording.substring(0, 100));
              break;
            }
          }

          // Check if there are more pages
          const hasNextPage = msgContainer.nextPage === true;
          lastMessageId = msgContainer.lastMessageId || messages[messages.length - 1]?.id;

          if (!hasNextPage || !lastMessageId) break;
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

async function extractCallDetails(transcript, callData, env, historicalContext) {
  try {
    const coachingBlock = historicalContext ? `

═══════════════════════════════════════════════════════════
HISTORICAL INTELLIGENCE — WHAT HAS WORKED FOR SUMMIT GROUP
═══════════════════════════════════════════════════════════
Below is a summary of past call outcomes from Summit Group's deal ledger. Use this data to inform your coaching recommendations. Compare this seller's signals against patterns from deals that went under contract vs. deals that were lost.

${historicalContext}
═══════════════════════════════════════════════════════════
` : "";

    const prompt = `You are a senior acquisitions analyst AND call coach for Summit Group Acquisitions, a real estate wholesaling company. You are analyzing a phone call transcript with a property seller. Your job is to:
1. Extract every piece of actionable deal intelligence from this call
2. Audit the call against Summit Group's 4-stage acquisitions script
3. Provide specific coaching on what to do next with THIS seller based on their responses, tone, and signals
${historicalContext ? "4. Compare this call's patterns against what has historically worked to get deals under contract" : ""}

Be extremely specific — no generic summaries. Quote the seller's words when possible. If a detail was not mentioned in the call, leave that field as an empty string.

══════════════════════════════════════════════
SUMMIT GROUP 4-STAGE ACQUISITIONS CALL SCRIPT
══════════════════════════════════════════════

STAGE 1 — BUILD RAPPORT & GATHER INFO (Initial Call)
Required info-gathering questions:
  1. "What has you wanting to sell?" — Discover the WHY (motivation)
  2. "Do you have a place in mind where you'd like to go?" — Post-sale plans
  3. Confirm house details: beds, baths, sq ft, garage, lot size, layout
  4. "How soon are you looking to have this wrapped up?" — Timeline/urgency
  5. "Do you know if there are any liens or anything owed on the property?" — Liens, mortgages, payoff
  6. "What are you hoping to get for the property?" — Asking price
  7. "Is that price negotiable at all, or is that pretty firm?" — Price flexibility
  8. "Would you be able to send some photos of the property?" — Visual condition assessment

KEY GREEN LIGHT PHRASES (seller is ready to move forward):
  - "I just want this done"
  - "Make me an offer"
  - "I'm flexible / open to negotiation"
  - "I need to sell quickly"
  - "Whatever works for you"
  - Volunteering information without being asked
  - Asking about YOUR process / timeline

KEY STALL SIGNALS (seller needs more nurture):
  - "I need to think about it"
  - "Let me talk to my [spouse/attorney/family]"
  - "I'm not in a rush"
  - "I want to see what else is out there"
  - "That's too low" (firm, defensive tone)
  - Short, one-word answers
  - Avoiding questions about motivation or timeline

STAGE 2 — TEAMS CALL (Presentation / Offer)
  - Present comparable sales and valuation
  - Explain acquisition strategy (cash, sub-to, seller finance, novation)
  - Present initial offer range
  - Handle objections using empathy and reframing

STAGE 3 — TEAMS CALL CLOSING
  - Lock in final price and terms
  - Set closing timeline
  - Collect signatures / LOI

STAGE 4 — FINAL CLOSE
  - Title company coordination
  - Final walkthrough
  - Closing execution

══════════════════════════════════════════════
${coachingBlock}
Return ONLY a valid JSON object with these exact keys:
{
  "property_address": "",
  "city_state": "",
  "asking_price": "NUMBERS ONLY, no $ or commas. e.g. 250000 not $250,000. Convert words to numbers (e.g. 'a million' = 1000000)",
  "property_type": "SFR|Multi-Family|Commercial|Land|Mobile Home|Condo/Townhouse|Other",

  "mortgage_details": "Extract ALL loan/mortgage information mentioned: current monthly payment, interest rate, loan type (FHA, VA, conventional), original purchase price, when they bought, remaining balance or payoff amount, whether payments are current or behind (and how many months), any second mortgages or liens, property tax status, HOA dues. If they mentioned what they owe vs what it's worth, calculate the approximate equity. Format clearly like: 'Bought in 2019 for $180K. Owes ~$155K. Payment: $1,200/mo at 3.5% conventional. Payments current. Estimated equity: ~$45K based on $200K asking.' If no mortgage info discussed, say 'Not discussed'.",

  "seller_pain_points": "Identify the specific reasons WHY the seller wants to sell. Look for: financial distress (behind on payments, tax liens, medical bills), life events (divorce, death in family, inheritance, relocation, job loss), property burden (costly repairs, vacant, tired landlord, code violations, hoarder situation), or timeline pressure (foreclosure deadline, need to move fast). List every pain point mentioned. If none are clear, note what you observed about their situation.",

  "price_flexibility": "Analyze the seller's tone and language around their asking price. Are they FIRM (used language like 'that's my bottom line', 'I won't take less', 'non-negotiable', got defensive when price was challenged, repeated the same number multiple times)? Are they FLEXIBLE (said things like 'make me an offer', 'I'm open to negotiation', 'that's just a ballpark', 'what were you thinking', hesitated on price, gave a range instead of a hard number)? Or UNKNOWN (price wasn't really discussed)? State FIRM, FLEXIBLE, or UNKNOWN, then explain exactly what they said or how they reacted that tells you this. Quote their words if possible.",

  "seller_next_plans": "What does the seller plan to do after selling? Be extremely specific. Are they buying another house? Renting? Moving to a specific city or state? Moving in with family? Downsizing? Going into assisted living? Relocating for a job? If they mentioned ANY specifics about their plans after selling, capture every detail here — this matters for structuring the deal. If not discussed, say 'Not discussed'.",

  "property_condition": "Note any details about the property's condition mentioned in the call: repairs needed, age of roof/HVAC/foundation, renovations done, square footage, bedrooms/bathrooms, garage, lot size, tenant situation (if rented), vacancy status. If not discussed, say 'Not discussed'.",

  "motivation_score": "Rate 1-10 based on pain points, price flexibility, and urgency combined. 9-10: Extreme urgency — foreclosure, must sell immediately, desperate, flexible on price. 7-8: High motivation — clear pain points, cooperative, wants offers, willing to negotiate. 5-6: Moderate — interested but no urgency, exploring options, somewhat firm on price. 3-4: Low — fishing for offers, not committed, firm on high price. 1-2: Not motivated — declined, not interested, or just curious.",
  "motivation_reason": "One sentence explaining WHY you gave that score, referencing pain points, price flexibility, and timeline together",

  "recommended_strategy": "Based on EVERYTHING from this call, recommend the best acquisition strategy for Summit Group. Consider these options and explain your reasoning:

CASH OFFER — Best when: seller needs to close fast, property has significant equity, price is at a discount, straightforward wholesale flip to a cash buyer.

SUBJECT-TO (take over existing loan) — Best when: seller has a low interest rate worth keeping (under 5%), limited equity (owing close to asking), payments are current, seller is moving and doesn't care about keeping the loan, seller plans to rent or move in with family (not buying another home that needs financing). Red flags: seller plans to buy another home (existing mortgage affects their DTI).

SELLER FINANCE — Best when: property is free and clear or high equity, seller doesn't need all cash at once, seller is retired/wants monthly income, flexible seller who doesn't need to buy another property.

NOVATION — Best when: property has equity but needs repairs, seller wants full retail price, you can renovate and list on MLS, seller is patient and cooperative.

HYBRID/CREATIVE — Combine strategies if the situation calls for it.

Give your recommendation as: 'RECOMMENDED: [Strategy]. [2-3 sentences explaining exactly why this strategy fits based on the specific details from this call — mortgage situation, equity position, seller motivation, price flexibility, their next plans, and timeline.]' If there isn't enough info from the call to make a recommendation, say what additional information you'd need to determine the best strategy.",

  "script_compliance": "Audit this call against the Stage 1 info-gathering checklist above. For each of the 8 required questions, mark whether it was: ASKED & ANSWERED (the rep asked and got a clear answer), ASKED BUT DODGED (asked but seller deflected or gave vague answer), or NOT ASKED (never came up). Format as:
1. Motivation (why selling): [status] — [what was said]
2. Post-sale plans: [status] — [what was said]
3. House details (bed/bath/sqft): [status] — [what was said]
4. Timeline: [status] — [what was said]
5. Liens/mortgage: [status] — [what was said]
6. Asking price: [status] — [what was said]
7. Price negotiable: [status] — [what was said]
8. Photos requested: [status] — [what was said]
Then add: 'SCRIPT SCORE: X/8 questions covered.'",

  "script_compliance_score": "Just the number 0-8 of how many info-gathering questions were asked",

  "call_stage": "Based on the content of this call, which stage of the 4-stage process is this seller currently in? STAGE 1 (initial info gathering — still building rapport and collecting details), STAGE 2 (ready for Teams call — have enough info to present an offer), STAGE 3 (in negotiation — actively discussing terms), or STAGE 4 (closing — executing the deal). State the stage and explain why.",

  "green_light_signals": "List every green light phrase or signal from the seller during this call. Quote their exact words. These indicate readiness to move forward. Examples: expressing urgency, asking about your process, volunteering info, showing flexibility. If none detected, say 'None detected — seller is guarded.'",

  "stall_signals": "List every stall signal or objection from the seller. Quote their exact words. These indicate the seller needs more nurture or has reservations. Examples: needing to think, consulting others, not in a rush, price defensiveness, short answers. If none detected, say 'None detected — seller seems ready to proceed.'",

  "seller_coaching": "Based on this specific seller's responses, tone, and signals throughout the call, provide a detailed game plan for the next interaction. Address:
1. SELLER READ: In 2-3 sentences, characterize this seller — what kind of person are they, what's driving them, what are they afraid of, what do they need to hear?
2. NEXT CALL APPROACH: Exactly how should the team open the next call? What tone should they set? What should they lead with?
3. OBJECTION HANDLING: If the seller raised objections or showed hesitation, provide the exact reframe or response to use next time. Reference specific things the seller said.
4. INFORMATION GAPS: What critical info is still missing that MUST be gathered on the next call before an offer can be made?
5. CLOSING STRATEGY: Based on where this seller is emotionally and in the process, what's the best path to getting them under contract? Be specific — not generic advice."
${historicalContext ? `,

  "pattern_match": "Compare this seller's signals, motivation, pain points, and price flexibility against the historical data provided. Do they match the profile of sellers who went under contract, or sellers who were lost? Specifically: What patterns from past WINS does this seller match? What patterns from past LOSSES should the team watch out for? Give a WIN PROBABILITY estimate (High/Medium/Low) based on historical patterns and explain your reasoning in 2-3 sentences."` : ""},

  "missed_items": "Review the ENTIRE transcript one more time as a senior acquisitions analyst. Flag ANYTHING that was mentioned in the call but not captured in the fields above — any detail about the property, the seller's situation, their finances, the neighborhood, other offers they've received, other people involved in the decision (spouse, attorney, co-owner), timeline details, liens, code violations, insurance issues, HOA problems, tenant situations, zoning, lot details, recent appraisals, realtor involvement, probate status, estate issues, or literally anything else relevant to evaluating this deal. Also flag important questions the team SHOULD HAVE asked but didn't — gaps in the conversation where critical info was left on the table. Format as two sections: 'MENTIONED BUT NOT CAPTURED: [list items]' and 'QUESTIONS YOU SHOULD HAVE ASKED: [list specific questions with brief reasoning for why they matter]'. If nothing was missed, say 'Call was thorough — no significant gaps identified.'",

  "call_summary": "2-3 sentence summary of the conversation — what was discussed, what the seller wants, and any key takeaways",
  "next_steps": "specific action items and follow-up tasks from this call",
  "callback_date": "MM/DD/YYYY format, or empty if no specific callback was scheduled"
}

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
        max_tokens: 8192,
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
  const painPoints = aiExtracted.seller_pain_points || "";
  const priceFlexibility = aiExtracted.price_flexibility || "";
  const sellerNextPlans = aiExtracted.seller_next_plans || "";
  const mortgageDetails = aiExtracted.mortgage_details || "";
  const propertyCondition = aiExtracted.property_condition || "";
  const strategy = aiExtracted.recommended_strategy || "";
  const missedItems = aiExtracted.missed_items || "";
  const motivationScore = aiExtracted.motivation_score || "";
  const motivationReason = aiExtracted.motivation_reason || "";
  const motivation = motivationScore ? `${motivationScore}/10 — ${motivationReason}` : "";
  const scriptCompliance = aiExtracted.script_compliance || "";
  const callStage = aiExtracted.call_stage || "";
  const greenLights = aiExtracted.green_light_signals || "";
  const stallSignals = aiExtracted.stall_signals || "";
  const sellerCoaching = aiExtracted.seller_coaching || "";
  const patternMatch = aiExtracted.pattern_match || "";

  const summary = [
    aiExtracted.call_summary || "",
    painPoints ? `\nPain Points: ${painPoints}` : "",
    priceFlexibility ? `\nPrice Flexibility: ${priceFlexibility}` : "",
    mortgageDetails && mortgageDetails !== "Not discussed" ? `\nMortgage: ${mortgageDetails}` : "",
    propertyCondition && propertyCondition !== "Not discussed" ? `\nProperty Condition: ${propertyCondition}` : "",
    sellerNextPlans && sellerNextPlans !== "Not discussed" ? `\nSeller's Plans: ${sellerNextPlans}` : "",
    greenLights && !greenLights.includes("None detected") ? `\n\nGREEN LIGHTS: ${greenLights}` : "",
    stallSignals && !stallSignals.includes("None detected") ? `\nSTALL SIGNALS: ${stallSignals}` : "",
    callStage ? `\nCALL STAGE: ${callStage}` : "",
    strategy ? `\n\n${strategy}` : "",
    patternMatch ? `\nPATTERN MATCH: ${patternMatch}` : "",
    scriptCompliance ? `\n\nSCRIPT AUDIT: ${scriptCompliance}` : "",
    sellerCoaching ? `\n\nCOACHING — NEXT CALL GAME PLAN:\n${sellerCoaching}` : "",
    missedItems && !missedItems.includes("no significant gaps") ? `\n\nCALL AUDIT: ${missedItems}` : "",
  ].filter(Boolean).join("");
  const nextSteps = aiExtracted.next_steps || "";
  const callbackDate = aiExtracted.callback_date || "";

  // Parse asking price — always output a clean number
  let priceValue = parseAskingPrice(askingPrice);

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
//  GHL — Push call summary back to contact notes
// ═══════════════════════════════════════════════════════════════════

async function updateGHLContactNotes(contactId, callData, aiExtracted, env) {
  try {
    const headers = {
      "Authorization": "Bearer " + env.GHL_API_KEY,
      "Version": "2021-07-28",
      "Content-Type": "application/json",
    };

    // Build the note body
    const callDate = new Date(callData.callDate);
    const dateStr = callDate.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
    const scoreStr = aiExtracted.motivation_score ? `${aiExtracted.motivation_score}/10` : "N/A";
    const noteBody = [
      `Summary: ${aiExtracted.call_summary || "N/A"}`,
      ``,
      `Pain Points: ${aiExtracted.seller_pain_points || "None identified"}`,
      `Price Flexibility: ${aiExtracted.price_flexibility || "Not discussed"}`,
      aiExtracted.mortgage_details && aiExtracted.mortgage_details !== "Not discussed" ? `Mortgage/Loan: ${aiExtracted.mortgage_details}` : "",
      aiExtracted.property_condition && aiExtracted.property_condition !== "Not discussed" ? `Property Condition: ${aiExtracted.property_condition}` : "",
      `Seller's Plans: ${aiExtracted.seller_next_plans || "Not discussed"}`,
      ``,
      `Motivation: ${scoreStr}${aiExtracted.motivation_reason ? " — " + aiExtracted.motivation_reason : ""}`,
      ``,
      aiExtracted.green_light_signals && !aiExtracted.green_light_signals.includes("None detected") ? `GREEN LIGHTS: ${aiExtracted.green_light_signals}` : "",
      aiExtracted.stall_signals && !aiExtracted.stall_signals.includes("None detected") ? `STALL SIGNALS: ${aiExtracted.stall_signals}` : "",
      aiExtracted.call_stage ? `STAGE: ${aiExtracted.call_stage}` : "",
      ``,
      aiExtracted.recommended_strategy ? `DEAL STRATEGY: ${aiExtracted.recommended_strategy}` : "",
      aiExtracted.pattern_match ? `PATTERN MATCH: ${aiExtracted.pattern_match}` : "",
      ``,
      aiExtracted.script_compliance ? `SCRIPT AUDIT: ${aiExtracted.script_compliance}` : "",
      ``,
      aiExtracted.seller_coaching ? `COACHING — NEXT CALL GAME PLAN:\n${aiExtracted.seller_coaching}` : "",
      ``,
      aiExtracted.missed_items && !aiExtracted.missed_items.includes("no significant gaps") ? `CALL AUDIT: ${aiExtracted.missed_items}` : "",
      ``,
      `Next Steps: ${aiExtracted.next_steps || "N/A"}`,
      aiExtracted.callback_date ? `Callback: ${aiExtracted.callback_date}` : "",
    ].filter(line => line !== undefined).join("\n");

    // Use the dedicated Notes API endpoint: POST /contacts/{id}/notes
    const noteResp = await fetch(`${GHL_API_BASE}/contacts/${contactId}/notes`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        body: noteBody,
      }),
    });

    if (noteResp.ok) {
      console.log("GHL note created for:", callData.sellerName);
    } else {
      const err = await noteResp.text();
      console.error("GHL note creation error:", noteResp.status, err.substring(0, 300));
    }
  } catch (err) {
    console.error("GHL note creation failed:", err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════
//  PHONE FORMATTER — strips country code, formats as (XXX) XXX-XXXX
// ═══════════════════════════════════════════════════════════════════

function formatPhone(raw) {
  if (!raw) return "";
  // Strip everything except digits
  let digits = raw.replace(/\D/g, "");
  // Remove leading 1 (US country code) if 11 digits
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.substring(1);
  }
  // Format as (XXX) XXX-XXXX
  if (digits.length === 10) {
    return `(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6)}`;
  }
  return raw; // Return original if not a standard US number
}


// ═══════════════════════════════════════════════════════════════════
//  ASKING PRICE PARSER — always returns a clean number
// ═══════════════════════════════════════════════════════════════════

function parseAskingPrice(raw) {
  if (!raw) return "";
  const str = String(raw).trim();

  // Try direct numeric parse (handles "$1,000,000", "250000", etc.)
  const cleaned = str.replace(/[$,\s]/g, "");
  const direct = parseFloat(cleaned);
  if (!isNaN(direct) && direct > 0) return direct;

  // Handle word-based amounts
  const lower = str.toLowerCase();
  const multipliers = {
    "million": 1000000, "mil": 1000000, "m": 1000000,
    "thousand": 1000, "k": 1000,
    "hundred thousand": 100000,
  };

  // Match patterns like "a million", "1.5 million", "500 thousand", "500k"
  for (const [word, mult] of Object.entries(multipliers)) {
    const regex = new RegExp(`([\\d.]+)?\\s*${word}`, "i");
    const match = lower.match(regex);
    if (match) {
      const num = match[1] ? parseFloat(match[1]) : 1;
      return num * mult;
    }
  }

  // Check for just "a million" / "a hundred thousand" etc.
  if (lower.includes("million")) return 1000000;
  if (lower.includes("hundred thousand")) return 100000;

  return str; // Return as-is if we can't parse it
}


// ═══════════════════════════════════════════════════════════════════
//  CALL INTELLIGENCE DB — Structured data for pattern learning
// ═══════════════════════════════════════════════════════════════════

const INTEL_TAB_NAME = "Call Intelligence DB";
const INTEL_HEADERS = [
  "Date", "Seller Name", "Phone", "Property Address", "City/State",
  "Asking Price", "Property Type", "Motivation Score", "Pain Points",
  "Price Flexibility", "Mortgage Details", "Seller Plans",
  "Property Condition", "Recommended Strategy", "Script Score",
  "Call Stage", "Green Lights", "Stall Signals", "Coaching Notes",
  "Pattern Match", "Outcome"
];

async function writeToIntelligenceDB(env, callData, aiExtracted) {
  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) return;

  const sheetId = env.GOOGLE_SHEET_ID;
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;

  // Ensure the tab exists (create it + add headers if not)
  await ensureIntelligenceDBTab(accessToken, baseUrl);

  // Find the next empty row
  const rangeResp = await fetch(
    `${baseUrl}/values/${encodeURIComponent(INTEL_TAB_NAME)}!A2:A1000`,
    { headers: { "Authorization": "Bearer " + accessToken } }
  );

  let nextRow = 2;
  if (rangeResp.ok) {
    const rangeData = await rangeResp.json();
    const values = rangeData.values || [];
    nextRow = 2 + values.length;
  }

  // Extract price flexibility keyword (FIRM/FLEXIBLE/UNKNOWN)
  const flexText = (aiExtracted.price_flexibility || "").toUpperCase();
  const flexKeyword = flexText.startsWith("FIRM") ? "FIRM"
    : flexText.startsWith("FLEXIBLE") ? "FLEXIBLE" : "UNKNOWN";

  // Extract strategy keyword
  const stratText = aiExtracted.recommended_strategy || "";
  const stratMatch = stratText.match(/RECOMMENDED:\s*([\w\s-]+?)\./);
  const stratKeyword = stratMatch ? stratMatch[1].trim() : stratText.substring(0, 30);

  const callDate = new Date(callData.callDate);
  const dateStr = `${(callDate.getMonth() + 1).toString().padStart(2, "0")}/${callDate.getDate().toString().padStart(2, "0")}/${callDate.getFullYear()}`;

  const rowValues = [
    dateStr,
    callData.sellerName,
    callData.phone,
    aiExtracted.property_address || callData.propertyAddress || "",
    aiExtracted.city_state || callData.cityState || "",
    aiExtracted.asking_price || callData.askingPrice || "",
    aiExtracted.property_type || callData.propertyType || "",
    aiExtracted.motivation_score || "",
    aiExtracted.seller_pain_points || "",
    flexKeyword,
    aiExtracted.mortgage_details || "",
    aiExtracted.seller_next_plans || "",
    aiExtracted.property_condition || "",
    stratKeyword,
    aiExtracted.script_compliance_score || "",
    aiExtracted.call_stage || "",
    aiExtracted.green_light_signals || "",
    aiExtracted.stall_signals || "",
    aiExtracted.seller_coaching || "",
    aiExtracted.pattern_match || "",
    "", // Outcome — filled manually by Aubrey
  ];

  const writeRange = `${INTEL_TAB_NAME}!A${nextRow}:U${nextRow}`;
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
    console.log(`Intelligence DB row ${nextRow} written for: ${callData.sellerName}`);
  } else {
    const err = await writeResp.text();
    console.error("Intelligence DB write error:", err);
  }
}

async function ensureIntelligenceDBTab(accessToken, baseUrl) {
  // Check if the tab exists
  const resp = await fetch(baseUrl, {
    headers: { "Authorization": "Bearer " + accessToken },
  });

  if (!resp.ok) return;

  const spreadsheet = await resp.json();
  const sheets = spreadsheet.sheets || [];
  const exists = sheets.some(s => s.properties.title === INTEL_TAB_NAME);

  if (!exists) {
    // Create the tab
    const addResp = await fetch(`${baseUrl}:batchUpdate`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [{
          addSheet: {
            properties: { title: INTEL_TAB_NAME },
          },
        }],
      }),
    });

    if (addResp.ok) {
      console.log("Created Intelligence DB tab");
    } else {
      const err = await addResp.text();
      console.error("Failed to create Intel tab:", err);
      return;
    }

    // Write headers
    const headerRange = `${INTEL_TAB_NAME}!A1:U1`;
    await fetch(
      `${baseUrl}/values/${encodeURIComponent(headerRange)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          "Authorization": "Bearer " + accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: [INTEL_HEADERS] }),
      }
    );
    console.log("Intelligence DB headers written");
  }
}


// ═══════════════════════════════════════════════════════════════════
//  COACHING CONTEXT — Read historical data and compute patterns
// ═══════════════════════════════════════════════════════════════════

async function buildCoachingContext(env) {
  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) return "";

  const sheetId = env.GOOGLE_SHEET_ID;
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;

  // Read Call Ledger for outcomes (column M) matched with key data
  // B=Date, C=Name, G=Asking Price, H=PropType, I=Motivation, M=Outcome
  const ledgerResp = await fetch(
    `${baseUrl}/values/${encodeURIComponent("Call Ledger")}!B5:M500`,
    { headers: { "Authorization": "Bearer " + accessToken } }
  );

  // Read Intelligence DB for structured past call data
  const intelResp = await fetch(
    `${baseUrl}/values/${encodeURIComponent(INTEL_TAB_NAME)}!A2:U500`,
    { headers: { "Authorization": "Bearer " + accessToken } }
  );

  let ledgerRows = [];
  let intelRows = [];

  if (ledgerResp.ok) {
    const data = await ledgerResp.json();
    ledgerRows = data.values || [];
  }

  if (intelResp.ok) {
    const data = await intelResp.json();
    intelRows = data.values || [];
  }

  const totalCalls = ledgerRows.length;
  if (totalCalls < 3) {
    console.log("Not enough historical data for coaching (need 3+ calls)");
    return "";
  }

  // Parse outcomes from ledger (column M = index 11 in B:M range)
  const outcomes = { contracted: [], lost: [], pending: [] };
  const strategies = {};
  const motivationBuckets = { contracted: [], lost: [] };
  const flexBuckets = { contracted: { FIRM: 0, FLEXIBLE: 0, UNKNOWN: 0 }, lost: { FIRM: 0, FLEXIBLE: 0, UNKNOWN: 0 } };
  const painPointPatterns = { contracted: [], lost: [] };
  const scriptScores = { contracted: [], lost: [] };

  for (let i = 0; i < intelRows.length; i++) {
    const row = intelRows[i];
    if (!row || row.length < 10) continue;

    // Match with ledger outcome — find same seller name
    const sellerName = row[1] || "";
    let outcome = (row[20] || "").toLowerCase().trim(); // Column U in intel DB

    // Also check ledger for outcome if intel DB doesn't have it
    if (!outcome) {
      for (const lrow of ledgerRows) {
        if (lrow[1] && lrow[1].trim().toLowerCase() === sellerName.toLowerCase()) {
          outcome = (lrow[11] || "").toLowerCase().trim(); // Column M in B:M range
          break;
        }
      }
    }

    const motivScore = parseInt(row[7]) || 0;
    const painPts = row[8] || "";
    const flex = (row[9] || "UNKNOWN").toUpperCase();
    const strategy = row[13] || "";
    const scriptScore = parseInt(row[14]) || 0;

    const bucket = outcome.includes("contract") || outcome.includes("closed") || outcome.includes("won")
      ? "contracted"
      : outcome.includes("lost") || outcome.includes("dead") || outcome.includes("no deal")
        ? "lost"
        : "pending";

    if (bucket === "contracted") {
      outcomes.contracted.push(sellerName);
      motivationBuckets.contracted.push(motivScore);
      flexBuckets.contracted[flex] = (flexBuckets.contracted[flex] || 0) + 1;
      if (painPts) painPointPatterns.contracted.push(painPts);
      scriptScores.contracted.push(scriptScore);
      if (strategy) strategies[strategy] = (strategies[strategy] || { wins: 0, total: 0 });
      if (strategy) strategies[strategy].wins++;
      if (strategy) strategies[strategy].total++;
    } else if (bucket === "lost") {
      outcomes.lost.push(sellerName);
      motivationBuckets.lost.push(motivScore);
      flexBuckets.lost[flex] = (flexBuckets.lost[flex] || 0) + 1;
      if (painPts) painPointPatterns.lost.push(painPts);
      scriptScores.lost.push(scriptScore);
      if (strategy) strategies[strategy] = strategies[strategy] || { wins: 0, total: 0 };
      if (strategy) strategies[strategy].total++;
    }
  }

  const contractedCount = outcomes.contracted.length;
  const lostCount = outcomes.lost.length;
  const pendingCount = totalCalls - contractedCount - lostCount;

  // Compute averages
  const avgMotivWin = motivationBuckets.contracted.length
    ? (motivationBuckets.contracted.reduce((a, b) => a + b, 0) / motivationBuckets.contracted.length).toFixed(1)
    : "N/A";
  const avgMotivLoss = motivationBuckets.lost.length
    ? (motivationBuckets.lost.reduce((a, b) => a + b, 0) / motivationBuckets.lost.length).toFixed(1)
    : "N/A";
  const avgScriptWin = scriptScores.contracted.length
    ? (scriptScores.contracted.reduce((a, b) => a + b, 0) / scriptScores.contracted.length).toFixed(1)
    : "N/A";
  const avgScriptLoss = scriptScores.lost.length
    ? (scriptScores.lost.reduce((a, b) => a + b, 0) / scriptScores.lost.length).toFixed(1)
    : "N/A";

  // Build strategy win rates
  const stratLines = Object.entries(strategies)
    .filter(([_, v]) => v.total >= 1)
    .map(([name, v]) => `  ${name}: ${v.wins}/${v.total} (${((v.wins / v.total) * 100).toFixed(0)}% win rate)`)
    .join("\n");

  // Find common pain points in wins vs losses
  const winPainSummary = painPointPatterns.contracted.length
    ? painPointPatterns.contracted.slice(-5).join(" | ")
    : "Not enough data";
  const lossPainSummary = painPointPatterns.lost.length
    ? painPointPatterns.lost.slice(-5).join(" | ")
    : "Not enough data";

  // Build the context string
  const context = `DEAL LEDGER STATS (${totalCalls} total calls):
  Under Contract/Closed: ${contractedCount}
  Lost/Dead: ${lostCount}
  Pending/In Progress: ${pendingCount}
  Win Rate: ${contractedCount + lostCount > 0 ? ((contractedCount / (contractedCount + lostCount)) * 100).toFixed(0) : "N/A"}%

MOTIVATION PATTERNS:
  Avg motivation score on WINS: ${avgMotivWin}/10
  Avg motivation score on LOSSES: ${avgMotivLoss}/10

SCRIPT COMPLIANCE PATTERNS:
  Avg script score on WINS: ${avgScriptWin}/8
  Avg script score on LOSSES: ${avgScriptLoss}/8

PRICE FLEXIBILITY ON WINS:
  FIRM: ${flexBuckets.contracted.FIRM} | FLEXIBLE: ${flexBuckets.contracted.FLEXIBLE} | UNKNOWN: ${flexBuckets.contracted.UNKNOWN}
PRICE FLEXIBILITY ON LOSSES:
  FIRM: ${flexBuckets.lost.FIRM} | FLEXIBLE: ${flexBuckets.lost.FLEXIBLE} | UNKNOWN: ${flexBuckets.lost.UNKNOWN}

STRATEGY WIN RATES:
${stratLines || "  Not enough outcome data yet"}

PAIN POINTS ON RECENT WINS:
  ${winPainSummary}

PAIN POINTS ON RECENT LOSSES:
  ${lossPainSummary}`;

  return context;
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
