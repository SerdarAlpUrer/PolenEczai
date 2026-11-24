import datetime
import html as html_lib
from html.parser import HTMLParser
import http.cookiejar
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request

SOURCE_URL = "https://www.eskisehireo.org.tr/eskisehir-nobetci-eczaneler/"
JINA_FALLBACK_URL = "https://r.jina.ai/" + SOURCE_URL
TR_TZ = datetime.timezone(datetime.timedelta(hours=3))

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": SOURCE_URL,
    "Origin": "https://www.eskisehireo.org.tr",
}

BLACKLIST_TERMS = ("çerez ayarları", "gizlilik", "cerez", "oben")
RURAL_DISTRICTS = (
    "ALPU",
    "BEYLİKOVA",
    "BEYLIKOVA",
    "ÇİFTELER",
    "CIFTELER",
    "GÜNYÜZÜ",
    "GUNYUZU",
    "HAN",
    "İNÖNÜ",
    "INONU",
    "MAHMUDİYE",
    "MAHMUDIYE",
    "MİHALGAZİ",
    "MIHALGAZI",
    "MİHALICÇIK",
    "MIHALICCIK",
    "SARICAKAYA",
    "SEYİTGAZİ",
    "SEYITGAZI",
    "SİVRİHİSAR",
    "SIVRIHISAR",
)


def tr_upper(text: str) -> str:
    return (
        (text or "")
        .replace("i", "İ")
        .replace("ı", "I")
        .replace("ğ", "Ğ")
        .replace("ü", "Ü")
        .replace("ş", "Ş")
        .replace("ö", "Ö")
        .replace("ç", "Ç")
        .upper()
    )


class _CardHTMLParser(HTMLParser):
    """Extracts .nobetci and .nobetcig card blocks using Python stdlib."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cards = []
        self._card_depth = 0
        self._cur = None
        self._in_h4 = False
        self._in_p = False
        self._cur_a_href = None
        self._cur_a_text = []

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)
        cls = attr_dict.get("class", "") or ""
        classes = cls.split()

        if self._card_depth == 0 and tag == "div" and (
            "nobetci" in classes or "nobetcig" in classes
        ):
            self._card_depth = 1
            self._cur = {
                "card_type": "nobetcig" if "nobetcig" in classes else "nobetci",
                "h4_parts": [],
                "p_parts": [],
                "all_parts": [],
                "links": [],
            }
            return

        if self._card_depth > 0:
            if tag == "div":
                self._card_depth += 1
            elif tag == "br":
                self._cur["all_parts"].append("\n")
                if self._in_h4:
                    self._cur["h4_parts"].append("\n")
                if self._in_p:
                    self._cur["p_parts"].append("\n")
            elif tag == "h4":
                self._in_h4 = True
            elif tag == "p":
                self._in_p = True
            elif tag == "a":
                self._cur_a_href = (attr_dict.get("href") or "").strip()
                self._cur_a_text = []
            elif tag == "i":
                i_cls = attr_dict.get("class", "") or ""
                if "fa-arrow-right" in i_cls and self._in_p:
                    self._cur["p_parts"].append(" — ")

    def handle_endtag(self, tag):
        if self._card_depth == 0:
            return

        if tag == "h4":
            self._in_h4 = False
        elif tag == "p":
            self._in_p = False
        elif tag == "a" and self._cur_a_href is not None:
            self._cur["links"].append(
                (self._cur_a_href, "".join(self._cur_a_text).strip())
            )
            self._cur_a_href = None
            self._cur_a_text = []
        elif tag == "div":
            self._card_depth -= 1
            if self._card_depth == 0 and self._cur:
                self.cards.append(self._cur)
                self._cur = None

    def handle_data(self, data):
        if self._card_depth == 0 or not self._cur:
            return
        self._cur["all_parts"].append(data)
        if self._in_h4:
            self._cur["h4_parts"].append(data)
        if self._in_p:
            self._cur["p_parts"].append(data)
        if self._cur_a_href is not None:
            self._cur_a_text.append(data)


def parse_shift_iso(dt_str: str) -> str:
    """Converts 'DD.MM.YYYY HH:MM' to ISO-8601 string in UTC+3."""
    if not dt_str:
        return ""
    m = re.match(r"^\s*(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})\s*$", dt_str)
    if not m:
        return ""
    day, month, year, hour, minute = (int(x) for x in m.groups())
    try:
        dt = datetime.datetime(year, month, day, hour, minute, tzinfo=TR_TZ)
        return dt.isoformat()
    except ValueError:
        return ""


def normalize_name_and_district(raw_h4: str, default_merkez: bool = False):
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in raw_h4.splitlines() if ln.strip()]
    joined = " - ".join(lines)
    joined = re.sub(r"\s+", " ", joined).strip(" -")

    ad = joined
    ilce = ""

    # Case 1: "KARTOPU ECZANESİ - MERKEZ-ODUNPAZARI" or "BİLGE ECZANESİ - - ODUNPAZARI -"
    if " - " in joined:
        parts = [p.strip(" -") for p in joined.split(" - ") if p.strip(" -")]
        if len(parts) >= 2:
            ad = parts[0]
            ilce = "-".join(parts[1:])

    # Case 2: "VENÜS ECZANESİ- ODUNPAZARI" or "ARCADIA ECZANESİMERKEZ-ODUNPAZARI"
    if not ilce:
        m = re.search(r"(ECZANES[İI])\s*[-–]?\s*(.+)$", joined, flags=re.IGNORECASE)
        if m and m.group(2).strip(" -"):
            ad = joined[: m.end(1)].strip(" -")
            ilce = m.group(2).strip(" -")

    ad = re.sub(r"\s+", " ", ad).strip(" -")
    ilce_up = tr_upper(ilce).strip(" -")

    if any(r in ilce_up for r in RURAL_DISTRICTS):
        return ad, ilce_up, False

    is_merkez = False
    if "ODUNPAZARI" in ilce_up:
        ilce_norm = "MERKEZ-ODUNPAZARI"
        is_merkez = True
    elif "TEPEBAŞI" in ilce_up or "TEPEBASI" in ilce_up:
        ilce_norm = "MERKEZ-TEPEBAŞI"
        is_merkez = True
    elif "MERKEZ" in ilce_up or (default_merkez and not ilce_up):
        ilce_norm = "MERKEZ"
        is_merkez = True
    else:
        ilce_norm = ilce_up or "BİLİNMİYOR"

    return ad, ilce_norm, is_merkez


def clean_address(raw_p: str, phone: str) -> str:
    if not raw_p:
        return ""
    lines = []
    for ln in raw_p.splitlines():
        s = re.sub(r"\s+", " ", ln).strip()
        if not s:
            continue
        # Skip standalone calendar date lines in .nobetcig cards ("29.11.2026")
        if re.match(r"^\d{2}\.\d{2}\.\d{4}$", s):
            continue
        # Skip shift interval lines
        if re.search(r"\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\s*/\s*\d{2}\.\d{2}\.\d{4}", s):
            continue
        # Skip map link text
        if re.search(r"eczaneyi\s+haritada", s, flags=re.IGNORECASE):
            continue
        if re.search(r"nöbetçidir", s, flags=re.IGNORECASE):
            continue
        if phone and s.replace(" ", "") == phone.replace(" ", ""):
            continue
        lines.append(s)

    addr = " ".join(lines)
    if phone:
        addr = addr.replace(phone, "")
    addr = re.sub(r"0\d{10}|0\d{3}\s?\d{3}\s?\d{2}\s?\d{2}", "", addr)
    addr = re.sub(
        r"\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\s*/\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}.*",
        "",
        addr,
    )
    addr = re.sub(r"eczaneyi\s+haritada.*", "", addr, flags=re.IGNORECASE)
    addr = re.sub(r"nöbetçidir\.?", "", addr, flags=re.IGNORECASE)
    addr = re.sub(r"\s*—\s*$", "", addr)
    addr = re.sub(r"\s{2,}", " ", addr).strip(" -—|,")
    return addr[:220]


def format_phone(raw_phone: str) -> str:
    digits = re.sub(r"\D", "", raw_phone or "")
    if len(digits) == 10 and not digits.startswith("0"):
        digits = "0" + digits
    if len(digits) == 11 and digits.startswith("0"):
        return f"{digits[:4]} {digits[4:7]} {digits[7:9]} {digits[9:11]}"
    return (raw_phone or "").strip()


def parse_pharmacies_html(html: str, default_merkez: bool = False) -> list:
    parser = _CardHTMLParser()
    parser.feed(html_lib.unescape(html or ""))
    pharmacies = []

    for c in parser.cards:
        raw_h4 = "".join(c["h4_parts"]).strip()
        if not raw_h4:
            continue
        if any(b in raw_h4.lower() for b in BLACKLIST_TERMS):
            continue

        ad, ilce, is_merkez = normalize_name_and_district(raw_h4, default_merkez=default_merkez)
        if not ad or len(ad) < 3 or not is_merkez:
            continue

        full_text = re.sub(r"\s+", " ", "".join(c["all_parts"])).strip()

        map_link = ""
        phone = ""
        for href, link_text in c["links"]:
            if not map_link and ("maps" in href.lower() or "google.com/maps" in href.lower()):
                map_link = href
            if not phone and href.lower().startswith("tel:"):
                phone = link_text or href[4:]

        if not phone:
            m_tel = re.search(r"0\s*\d{3}\s*\d{3}\s*\d{2}\s*\d{2}", full_text)
            if m_tel:
                phone = m_tel.group(0)
        phone_clean = re.sub(r"\D", "", phone)
        if len(phone_clean) == 10:
            phone_clean = "0" + phone_clean
        phone_display = format_phone(phone_clean or phone)

        lat, lon = None, None
        m_coord = re.search(r"q=\s*([-\d.]+)\s*,\s*([-\d.]+)", map_link)
        if m_coord:
            lat, lon = m_coord.group(1), m_coord.group(2)

        nobet_baslangic, nobet_bitis = "", ""
        m_shift = re.search(
            r"(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})\s*/\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})",
            full_text,
        )
        if m_shift:
            nobet_baslangic = m_shift.group(1).strip()
            nobet_bitis = m_shift.group(2).strip()

        raw_p = "".join(c["p_parts"])
        address = clean_address(raw_p, phone)

        pharmacies.append(
            {
                "ad": ad,
                "ilce": ilce,
                "adres": address,
                "telefon": phone_display,
                "telefon_raw": phone_clean,
                "lat": lat,
                "lon": lon,
                "harita_link": map_link,
                "nobet_baslangic": nobet_baslangic,
                "nobet_bitis": nobet_bitis,
                "start_iso": parse_shift_iso(nobet_baslangic),
                "end_iso": parse_shift_iso(nobet_bitis),
                "card_type": c["card_type"],
            }
        )

    return pharmacies


def parse_jina_markdown(md_text: str) -> list:
    """Fallback parser for https://r.jina.ai/ markdown response."""
    pharmacies = []
    blocks = re.split(r"^####\s+", md_text or "", flags=re.MULTILINE)
    for blk in blocks[1:]:
        lines = [ln.strip() for ln in blk.splitlines() if ln.strip()]
        if not lines:
            continue
        header = re.sub(r"\*+", "", lines[0]).strip()
        if any(b in header.lower() for b in BLACKLIST_TERMS):
            continue
        ad, ilce, is_merkez = normalize_name_and_district(header)
        if not ad or not is_merkez:
            continue

        body = "\n".join(lines[1:])
        m_tel = re.search(r"\(tel:([^)]+)\)", body)
        phone_raw = re.sub(r"\D", "", m_tel.group(1)) if m_tel else ""
        if not phone_raw:
            m_t2 = re.search(r"0\d{10}", body)
            if m_t2:
                phone_raw = m_t2.group(0)

        m_map = re.search(r"\((https?://[^)\s]*maps[^)\s]*)", body)
        map_link = m_map.group(1) if m_map else ""
        lat, lon = None, None
        m_coord = re.search(r"q=([-\d.]+),([-\d.]+)", map_link)
        if m_coord:
            lat, lon = m_coord.group(1), m_coord.group(2)

        nobet_baslangic, nobet_bitis = "", ""
        m_shift = re.search(
            r"(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})\s*/\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})",
            body,
        )
        if m_shift:
            nobet_baslangic, nobet_bitis = m_shift.group(1), m_shift.group(2)

        addr_lines = []
        for ln in lines[1:]:
            if ln.startswith("![") or ln.startswith("[") or ln.startswith("* *"):
                continue
            if re.search(r"\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}", ln):
                continue
            addr_lines.append(ln)
        address = clean_address("\n".join(addr_lines), phone_raw)

        pharmacies.append(
            {
                "ad": ad,
                "ilce": ilce,
                "adres": address,
                "telefon": format_phone(phone_raw),
                "telefon_raw": phone_raw,
                "lat": lat,
                "lon": lon,
                "harita_link": map_link,
                "nobet_baslangic": nobet_baslangic,
                "nobet_bitis": nobet_bitis,
                "start_iso": parse_shift_iso(nobet_baslangic),
                "end_iso": parse_shift_iso(nobet_bitis),
                "card_type": "nobetci",
            }
        )
    return pharmacies


def _build_opener():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx),
        urllib.request.HTTPCookieProcessor(cj),
    )


def _fetch_with_retries(opener, req, max_retries: int = 3, timeout: int = 25) -> str:
    for attempt in range(1, max_retries + 1):
        try:
            with opener.open(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8", errors="replace")
            if len(text) >= 100:
                return text
        except Exception as exc:
            print(f"  [Uyari] Deneme {attempt}/{max_retries} hatasi: {exc}")
        if attempt < max_retries:
            time.sleep(3 * attempt)
    return ""


def collect_pharmacy_data(days_ahead: int = 5) -> dict:
    """
    Fetches live active duty pharmacies (GET) PLUS a multi-day rolling schedule (POST)
    so that even if scheduled jobs are delayed by hours or days, upcoming shifts are ready.
    """
    opener = _build_opener()
    merged = []
    seen_keys = set()

    def add_items(items):
        for item in items:
            key = (
                re.sub(r"\s+", " ", tr_upper(item["ad"])).strip(),
                item.get("nobet_baslangic") or "",
                item.get("nobet_bitis") or "",
            )
            if key not in seen_keys:
                seen_keys.add(key)
                merged.append(item)

    # 1. Live GET (captures current shifts & any instant swaps)
    print(f"[1/2] Canli sayfa cekiliyor: {SOURCE_URL}")
    live_req = urllib.request.Request(SOURCE_URL, headers=HEADERS)
    live_html = _fetch_with_retries(opener, live_req, max_retries=3, timeout=30)
    if live_html:
        live_items = parse_pharmacies_html(live_html, default_merkez=False)
        print(f"  -> Canli sayfadan {len(live_items)} merkez eczane alindi.")
        add_items(live_items)

    # 2. Multi-day POST schedule (today .. today + days_ahead - 1) for ilce=100 (Merkez)
    now_tr = datetime.datetime.now(TR_TZ)
    if days_ahead > 0:
        print(f"[2/2] {days_ahead} gunluk ileri vardiya takvimi cekiliyor...")
        for offset in range(days_ahead):
            target_date = (now_tr + datetime.timedelta(days=offset)).strftime("%Y-%m-%d")
            form_body = urllib.parse.urlencode(
                {
                    "tarih1": target_date,
                    "ilce": "100",
                    "gnr": "NÖBETLERİ GÖSTER",
                }
            ).encode("utf-8")
            post_req = urllib.request.Request(SOURCE_URL, data=form_body, headers=HEADERS)
            day_html = _fetch_with_retries(opener, post_req, max_retries=2, timeout=20)
            if day_html:
                day_items = parse_pharmacies_html(day_html, default_merkez=True)
                print(f"  -> {target_date}: {len(day_items)} merkez eczane")
                add_items(day_items)

    # 3. Secondary fallback via r.jina.ai if primary connection was blocked/down
    if not merged:
        print("[Yedek] Ana kaynak yanit vermedi, Jina yedek kaynagi deneniyor...")
        jina_req = urllib.request.Request(
            JINA_FALLBACK_URL, headers={"User-Agent": HEADERS["User-Agent"]}
        )
        jina_md = _fetch_with_retries(opener, jina_req, max_retries=2, timeout=20)
        if jina_md:
            jina_items = parse_jina_markdown(jina_md)
            print(f"  -> Yedek kaynaktan {len(jina_items)} merkez eczane alindi.")
            add_items(jina_items)

    return {
        "last_updated": datetime.datetime.now(TR_TZ).isoformat(),
        "source": "eskisehireo.org.tr",
        "window_days": days_ahead,
        "pharmacies": merged,
    }


def main():
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
    result = collect_pharmacy_data(days_ahead=5)
    pharmacies = result.get("pharmacies", [])

    if not pharmacies:
        print("HATA: Gecerli eczane verisi cekilemedi! Mevcut data.json korunuyor.")
        sys.exit(1)

    tmp_path = output_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, output_path)
    print(
        f"Basarili: {len(pharmacies)} vardiya kaydi 'data.json' dosyasina yazildi "
        f"({result['last_updated']})."
    )


if __name__ == "__main__":
    main()
