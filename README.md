# Polen Eczanesi Nöbetçi Eczane Ekranı 🌙💊

Eskişehir Eczacı Odası verilerini kullanarak **Polen Eczanesi** vitrin ekranı (Xiaomi TV Box S 4K / Kiosk) ve hasta cep telefonları için özel olarak tasarlanmış, kesintisiz çalışan nöbetçi eczane bilgi sistemidir.

## ✨ Temel Özellikler

- **5 Günlük İleri Takvim + Canlı Veri (Sıfır Kesinti):** `scraper.py` hem anlık nöbet listesini hem de önümüzdeki 5 günün Eskişehir Merkez (`Odunpazarı` & `Tepebaşı`) vardiya takvimini çeker. Zamanlanmış görevler gecikse bile ekran sabah `08:30` ve akşam `18:30` vardiya geçişlerini saniyesi saniyesine otomatik yapar.
- **3 Katmanlı Veri Yedeklemesi (Auto-Failover):** Yerel API (`/api/pharmacies`) → Statik Takvim (`data.json`) → Canlı Yedek Vekil (`r.jina.ai`) sırasıyla çalışır; veri eskiyse ekranda açık bilgilendirme şeridi gösterir.
- **Gerçek Yürüme (`🚶`) ve Araç (`🚗`) Süresi + Canlı Harita Rotası:** Polen Eczanesi konumundan yakın eczaneler için gerçek yaya yürüyüş süresini ve mesafesini, uzak eczaneler için araç süresini hesaplar ve harita üzerinde yol rotasını çizer.
- **Yarı Nöbet ve Kapanış Uyarısı:** Gece yarısı veya erken saatte nöbeti bitecek eczaneleri ve kapanmasına 60 dakikadan az kalan nöbetçileri (`⏳ Kapanmasına X dk kaldı`) otomatik işaretler.
- **İlçe Hızlı Filtresi & Mobil "Cebe Al" Görünümü (`?mobil=1`):** Vitrindeki QR kodu okutan hastalar, kendi telefonlarında tek dokunuşla **Hemen Ara** ve **Yol Tarifi Al** butonlarıyla listeyi kullanabilir.
- **4K TV, Kiosk ve A4 Yazdırma Desteği:** Xiaomi TV kumandası (D-Pad odaklanma), açık/koyu tema, hava durumu tavsiyeleri, kampanya alanı ve A4 çıktı formatı içerir.

## 🚀 Kurulum ve Kullanım

Harici hiçbir `pip` paketi gerektirmez (yalnızca Python 3.10+ standart kütüphanesi):

```bash
# Veriyi manuel güncellemek için:
py scraper.py

# Yerel ağda sunucuyu başlatmak için (http://localhost:5050):
py server.py
```
