Manuel QA Kontrol Listesi – PDF’ten Veri İçe Aktarma

1) Metin tabanlı (vektör) PDF – basit tablo
- PDF yükle → sayfa seç → ROI çiz.
- Yöntem: Hızlı Tara (Tarayıcı-içi)
- Beklenen: Header otomatik eşleme önerisi makul; tablo önizlemesi düzgün.
- Doğrulama: Draft artan, TPC/MCT1cm > 0, LCF aralıkta uyarısız/az uyarılı.

2) Düşük kalite tarama PDF
- Hızlı Tara başarısızsa ROI’yi daraltın; yine başarısızsa Zor Dosya (PaddleOCR) deneyin.
- Beklenen: PaddleOCR ile metin ve tablo yakalaması iyileşir.

3) Confidence ve renklendirme (gözle kontrol)
- Önizlemedeki düşük güven hücreleri (varsa) uyarı niteliğinde belirlensin.

4) Birim/format normalizasyonu
- Virgül/nokta ve “−” işareti varyasyonları doğru sayıya dönüşüyor mu?

5) JSON indir ve App’e aktar
- JSON indir → dileğinizce saklayın.
- App’e Aktar → Sonuç kartında enterpolasyonlar değişiyor mu? (Hesap ekranı stabil kalmalı)

6) PaddleOCR servis bağlantısı
- Sunucu kapalıyken “Zor Dosya” seçeneği devre dışı görünüyor mu? Bilgilendirme mesajı var mı?
- Sunucu açıkken yöntem seçilebiliyor mu?

