/**
 * Cloud OCR stubs (Google Document AI, AWS Textract, Azure Document Intelligence)
 * These are intentionally not exported by default. Enable by setting FEATURE_CLOUD_OCR=true in constants.js
 * and wiring UI to call the desired function after providing credentials.
 * @file scripts/import/cloud-ocr-stubs.js
 */

// Feature flag (read from globals if present)
const FEATURE_CLOUD_OCR = (typeof window !== 'undefined' && window.FEATURE_CLOUD_OCR === true);

// --- Google Document AI ---
async function googleDocAIProcessImage(base64Image, {
  GOOGLE_PROJECT_ID,
  GOOGLE_LOCATION,
  GOOGLE_PROCESSOR_ID,
  GOOGLE_API_KEY,
}) {
  const endpoint = `https://us-documentai.googleapis.com/v1/projects/${encodeURIComponent(GOOGLE_PROJECT_ID)}/locations/${encodeURIComponent(GOOGLE_LOCATION)}/processors/${encodeURIComponent(GOOGLE_PROCESSOR_ID)}:process?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
  const payload = { rawDocument: { content: base64Image, mimeType: 'image/png' } };
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`DocumentAI error ${res.status}`);
  return await res.json();
}

// --- AWS Textract --- (SigV4 signing required; omitted for brevity)
async function awsTextractAnalyze(base64Image, {
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
}) {
  // Placeholder to show intent; implement SigV4 or use API Gateway proxy.
  throw new Error('AWS Textract stub: Not enabled. Configure SigV4 and enable FEATURE_CLOUD_OCR to use.');
}

// --- Azure Document Intelligence ---
async function azureDocIntelligenceAnalyze(base64Image, {
  AZURE_FORMRECOGNIZER_ENDPOINT,
  AZURE_KEY,
}) {
  const url = `${AZURE_FORMRECOGNIZER_ENDPOINT.replace(/\/$/, '')}/formrecognizer/documentModels/prebuilt-layout:analyze?api-version=2023-07-31`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Ocp-Apim-Subscription-Key': AZURE_KEY }, body: base64ToBlob(base64Image) });
  if (res.status === 202) {
    const op = res.headers.get('operation-location');
    // Caller should poll op URL; stubbed here
    return { operationLocation: op };
  }
  throw new Error(`Azure DI error ${res.status}`);
}

function base64ToBlob(dataURI) {
  const byteString = atob(dataURI.split(',')[1] || '');
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
  return new Blob([ab], { type: 'application/octet-stream' });
}

// Intentionally not exporting unless feature enabled
if (FEATURE_CLOUD_OCR) {
  // eslint-disable-next-line no-undef
  window.CloudOCR = { googleDocAIProcessImage, awsTextractAnalyze, azureDocIntelligenceAnalyze };
}

