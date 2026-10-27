// ─────────────────────────────────────────────────────────────
//  Fill these in after setting up Supabase (see README, step 7).
//  These values are safe to publish: the anon key and the VAPID
//  PUBLIC key are meant to be public. Never put the service role
//  key or the VAPID PRIVATE key here.
// ─────────────────────────────────────────────────────────────
window.APP_CONFIG = {
  // Supabase → Settings → API → Project URL
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",

  // Supabase → Settings → API → anon public key
  SUPABASE_ANON_KEY: "YOUR-SUPABASE-ANON-KEY",

  // From docs/keys.html → "Public key"
  VAPID_PUBLIC_KEY: "YOUR-VAPID-PUBLIC-KEY",

  // Shown in the app header
  COMPANY_NAME: "Floor Task Board",

  // Turn on only after setting up an SMS provider in Supabase (README, optional step)
  ENABLE_MOBILE_OTP: false,
};
