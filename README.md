Tanker Draft & Trim Hesaplayıcı (Basit)

Özet
- Bu tek sayfalık web uygulaması, “hydrostatic_extracted.pdf” (veya ondan türetilmiş hydrostatic_gemini.docx) içindeki hidrostatik tabloları `data/hydrostatics.json` dosyasına aktararak TPC, MCT1cm ve LCF değerlerini drafta bağlı olarak kullanır. Yük/ballast/FO+FW girişlerinden vasat, baş ve kıç draftlarını ve trim’i hesaplar.
- Varsayılan olarak hidrostatik tablo bulunursa TPC/MCT1cm/LCF değerleri vasat drafta göre doğrusal enterpole edilir ve iteratif olarak kendini tutarlı hale getirir. İsterseniz yine tek seferlik override alanlarıyla değerleri manuel geçersiz kılabilirsiniz. FO+FW tek bir LCG noktasında toplanmıştır.

Girdiler
- Deniz suyu yoğunluğu ρ (varsayılan 1.025 t/m³)
- FO+FW toplamı (t) – tek değer; LCG sabittir (PDF’teki tipik yükleme sayfası toplamlarından türetildi)
- Yük tankları ve balast tankları ağırlıkları (t)

Çıktılar
- Toplam ağırlık, toplam boyuna moment (midship referanslı)
- Vasat draft (m), Kıç draft (m), Baş draft (m)
- Trim (cm, kıça +)

Hesap Formülleri
- ΔTmean(cm) = (W / TPC) × (ρ_ref / ρ); Tmean(m) = ΔTmean/100 (TPC drafta bağlı olarak tablodan alınır)
- Trim(cm, by stern +) = − Σ w_i·(x_i − LCF) / MCT1cm (LCF ve MCT1cm tablodan enterpole edilir)
- DF = Tmean − Trim(m) × (LBP/2 + LCF) / LBP
- DA = Tmean + Trim(m) × (LBP/2 − LCF) / LBP
- Burada x_i midship’ten (ileri +), LCF midship’ten ölçülüdür. LBP PDF’teki değerden alınmıştır.

Kaynak Sabitler ve Veriler
- LBP ≈ 171.2 m (PDF: Midship = 85.60 m ⇒ LBP ≈ 171.2 m)
- Hidrostatikler: `data/hydrostatics.json` (kaynak: hydrostatic_extracted.pdf). Sütunlar: draft(m), LCF(m), TPC(t/cm), MCT1cm(t·m/cm).
- Override edilmezse program bu tabloyu kullanır; override edilirse tek değerler geçerli olur.
- FO+FW LCG ≈ −56.232 m (PDF’teki tipik yükleme sayfasındaki toplamlar ile ağırlık-ortalaması)
- Tank LCG listeleri: PDF’teki yükleme sayfalarından ve tank tablolarından okunmuş yaklaşık değerler (midship referanslı; + ileri).

Notlar
- Bu araç eğitim/planlama amaçlıdır; ayrıntılı emniyet/kabul hesaplarının yerini tutmaz.
- PDF OCR’si nedeniyle bazı değerler yuvarlatılmış/ yaklaşık olabilir. İsterseniz LCG listelerini güncellememi isteyebilirsiniz.

Kullanım
- index.html dosyasını tarayıcıda açın (veya basit bir http sunucusuyla servis edin ki `data/*.json` dosyaları okunabilsin).
- Girdileri doldurup “Hesapla” butonuna basın. Sonuç kartında kullanılan LCF/TPC/MCT1cm anlık olarak görüntülenir.

PDF’ten Veri İçe Aktarma Sihirbazı
- Üstteki “PDF’ten İçe Aktar” butonuna tıklayın.
- Adımlar: PDF yükle → thumbnail ızgarasından sayfa seç → tablo bölgesi (ROI) çiz → çıkarım yöntemi seç (“Hızlı Tara” veya “Zor Dosya/PaddleOCR”) → tablo önizleme ve kolon eşleme → doğrulama → App’e aktar + JSON indir.
- Hızlı Tara (tarayıcı-içi): pdf.js + Tesseract.js kullanır. Metin tabanlı PDF’lerde text layer’dan tablo klasterleme yapılır.
- Zor Dosya (PaddleOCR): Yerel bir mikroservis gerekir; ulaşılmazsa buton otomatik devre dışı kalır ve tarayıcı-içi yönteme düşer.
- Çıktı: Uygulamadaki hidrostatik tabloyu geçici olarak günceller (mevcut ekranları bozmaz). İsterseniz JSON olarak indirebilirsiniz.

PaddleOCR Sunucusu (Ücretsiz, Zor Dosyalar İçin)
- 1‑Tık Render Deploy (önerilir):
  - Aşağıdaki butona tıklayın ve Render hesabınızda (ücretsiz plan) kurulumu tamamlayın.

  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kagantatlici/draft_calculator)

  - render.yaml bu repoda hazır. Deploy sonrası size `https://<proje-adı>.onrender.com` gibi HTTPS bir adres verilecek.
  - Uygulamada “Gemi Ekle” penceresindeki “PaddleOCR Sunucu URL” alanına bu adresi yazın ve “Kaydet & Test” deyin.

- Yerelde Docker ile (alternatif):
  1) `cd server/paddleocr`
  2) `docker build -t ocr .`
  3) `docker run --rm -p 5001:5001 ocr`
- CORS ve PNA: Sunucu, CORS’u açık ve `Access-Control-Allow-Private-Network: true` başlığı ile yanıt verir. Sayfa HTTPS iken `http://127.0.0.1:5001` erişimi tarayıcı tarafından engellenebilir (Mixed Content). Bu durumda tarayıcı-içi OCR’a düşülür ve UI’da bilgilendirme gösterilir.
- Varsayılan taban URL: `http://127.0.0.1:5001`. Değiştirmek için tarayıcı konsolunda `localStorage.setItem('PADDLE_BASE','http://HOST:PORT')` yazabilirsiniz.
 - Alternatif olarak, “Gemi Ekle” modali içinde “PaddleOCR Sunucu URL (HTTPS)” alanıyla GUI üzerinden kaydedip health‑check yapabilirsiniz.

Bulut OCR (Opsiyonel, Varsayılan Kapalı)
- Google Document AI / AWS Textract / Azure Document Intelligence için `scripts/import/cloud-ocr-stubs.js` içinde stub çağrılar hazırdır fakat DEVRE DIŞI.
- Etkinleştirme: `constants.js` içine `window.FEATURE_CLOUD_OCR = true;` ekleyin ve UI’de BYO anahtarlarınızı girerek (kod tarafını genişletmeniz gerekir) açın. Varsayılan olarak toggle devre dışıdır ve hiçbir çağrı yapılmaz.

Testler (Manuel)
- `tests/manual.md` dosyasındaki kontrol listesini izleyin:
  - Metin tabanlı basit tablo → “Hızlı Tara” ile eşleme doğru mu?
  - Düşük kaliteli tarama → “Hızlı Tara” başarısızsa “Zor Dosya” ile doğruluk artıyor mu?
  - Confidence renklendirme/özet ve birim/mantık uyarıları tetikleniyor mu?
  - JSON indir → tekrar yükle → hesap ekranında regresyon yok mu?
