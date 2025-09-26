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
