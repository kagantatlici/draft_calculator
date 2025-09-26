// Basitleştirilmiş gemi sabitleri ve tank LCG’leri
// Kaynak: Trim & Stability Booklet (MAGNI ALEXA) – OCR ile yaklaşık değerler

// Hidrostatik sabitler (referans vasat draft civarı)
const SHIP = {
  // LBP: Midship, AP/FP mesafeleri için gerekli (m)
  LBP: 171.2, // PDF: Midship = 85.60 m => LBP ≈ 171.2 m

  // LCF (m, midship’ten; + ileri)
  // Not: 8.00 m civarı için tablo değeri yaklaşık -0.62 m bulunmuştur (OCR)
  LCF: -0.62,

  // TPC (t/cm) ve MCT1cm (t·m/cm) – 8.0 m civarı yaklaşık
  TPC: 49.4,
  MCT1cm: 547.0,

  // Referans tuzlusu yoğunluğu (t/m^3)
  RHO_REF: 1.025,
};

// FO+FW tek giriş LCG’i (m, midship’ten; + ileri, - kıç)
// PDF’teki tipik yükleme sayfası toplamlarından türetilmiş ~ -56.23 m
const LCG_FO_FW = -56.232;

// Yük tankları listesi (her biri sabit LCG; kullanıcı ağırlığı girer)
// Adlandırma: No.X P/S ve Slop P/S
const CARGO_TANKS = [
  { id: 'C1P', name: 'No.1 CARGO TK (P)', lcg: 63.305 },
  { id: 'C1S', name: 'No.1 CARGO TK (S)', lcg: 63.305 },
  { id: 'C2P', name: 'No.2 CARGO TK (P)', lcg: 43.495 },
  { id: 'C2S', name: 'No.2 CARGO TK (S)', lcg: 43.495 },
  { id: 'C3P', name: 'No.3 CARGO TK (P)', lcg: 22.616 },
  { id: 'C3S', name: 'No.3 CARGO TK (S)', lcg: 22.616 },
  { id: 'C4P', name: 'No.4 CARGO TK (P)', lcg: 1.796 },
  { id: 'C4S', name: 'No.4 CARGO TK (S)', lcg: 1.796 },
  { id: 'C5P', name: 'No.5 CARGO TK (P)', lcg: -19.083 },
  { id: 'C5S', name: 'No.5 CARGO TK (S)', lcg: -19.083 },
  { id: 'C6P', name: 'No.6 CARGO TK (P)', lcg: -39.335 },
  { id: 'C6S', name: 'No.6 CARGO TK (S)', lcg: -39.335 },
  { id: 'SLP', name: 'Slop TK (P)', lcg: -51.334 },
  { id: 'SLS', name: 'Slop TK (S)', lcg: -51.334 },
];

// Balast tankları (yaklaşık LCG’ler)
const BALLAST_TANKS = [
  { id: 'FPT', name: 'F.P. TK (C)', lcg: 80.567 },
  { id: 'WB1P', name: 'No.1 W.B. TK (P)', lcg: 65.051 },
  { id: 'WB1S', name: 'No.1 W.B. TK (S)', lcg: 65.024 },
  { id: 'WB2P', name: 'No.2 W.B. TK (P)', lcg: 44.445 },
  { id: 'WB2S', name: 'No.2 W.B. TK (S)', lcg: 44.445 },
  { id: 'WB3P', name: 'No.3 W.B. TK (P)', lcg: 23.534 },
  { id: 'WB3S', name: 'No.3 W.B. TK (S)', lcg: 23.542 },
  { id: 'WB4P', name: 'No.4 W.B. TK (P)', lcg: 2.659 },
  { id: 'WB4S', name: 'No.4 W.B. TK (S)', lcg: 2.662 },
  { id: 'WB5P', name: 'No.5 W.B. TK (P)', lcg: -18.136 },
  { id: 'WB5S', name: 'No.5 W.B. TK (S)', lcg: -18.136 },
  { id: 'WB6P', name: 'No.6 W.B. TK (P)', lcg: -41.580 },
  { id: 'WB6S', name: 'No.6 W.B. TK (S)', lcg: -41.580 },
];

// Globals for non-module usage (file:// compatibility)
window.SHIP = SHIP;
window.LCG_FO_FW = LCG_FO_FW;
window.CARGO_TANKS = CARGO_TANKS;
window.BALLAST_TANKS = BALLAST_TANKS;

// Light ship (approx from booklet; you can adjust)
window.LIGHT_SHIP = { weight: 9070, lcg: -9.85 };
