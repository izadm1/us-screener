"""Symbols screened. Edit freely — Yahoo Finance tickers.

Benchmarks are used for relative strength: stocks/ETFs vs SPY, crypto vs BTC.
"""

STOCKS = [
    # Mega / large-cap tech & comms
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "ORCL", "AMD",
    "NFLX", "CRM", "ADBE", "INTC", "QCOM", "TXN", "MU", "AMAT", "LRCX", "KLAC",
    "ARM", "SMCI", "PLTR", "SNOW", "CRWD", "PANW", "NET", "DDOG", "SHOP", "UBER",
    "ABNB", "COIN", "MSTR", "HOOD", "SOFI", "RBLX", "U", "DELL", "ANET", "MRVL",
    # Financials
    "JPM", "BAC", "WFC", "GS", "MS", "C", "SCHW", "V", "MA", "PYPL", "AXP", "BRK-B",
    # Healthcare
    "UNH", "LLY", "JNJ", "ABBV", "MRK", "PFE", "TMO", "ISRG", "AMGN", "GILD", "NVO",
    # Consumer
    "WMT", "COST", "HD", "LOW", "MCD", "SBUX", "NKE", "KO", "PEP", "PG", "DIS",
    "TGT", "LULU", "CMG",
    # Energy / industrials / materials
    "XOM", "CVX", "COP", "OXY", "SLB", "CAT", "DE", "BA", "GE", "LMT", "RTX", "HON",
    "UPS", "FCX", "NEM",
    # Popular high-beta day-trading names
    "RIVN", "LCID", "NIO", "MARA", "RIOT", "AFRM", "UPST", "IONQ", "RKLB", "SOUN",
]

ETFS = [
    "SPY", "QQQ", "DIA", "IWM", "VTI", "VOO", "RSP",
    "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC",
    "SMH", "SOXX", "ARKK", "IGV", "KRE", "XBI", "ITB", "XHB", "JETS",
    "TLT", "IEF", "SHY", "HYG", "LQD",
    "GLD", "SLV", "USO", "UNG", "DBC",
    "EEM", "EFA", "FXI", "EWJ", "EWZ", "INDA", "EWM",
    "TQQQ", "SQQQ", "SOXL", "SOXS", "UVXY",
    "IBIT", "ETHA",
]

INDICES = {
    "^GSPC": "S&P 500", "^NDX": "Nasdaq 100", "^IXIC": "Nasdaq Composite",
    "^DJI": "Dow Jones", "^RUT": "Russell 2000", "^VIX": "VIX",
    "^FTSE": "FTSE 100", "^GDAXI": "DAX", "^FCHI": "CAC 40", "^STOXX50E": "Euro Stoxx 50",
    "^N225": "Nikkei 225", "^HSI": "Hang Seng", "000001.SS": "Shanghai Composite",
    "^KLSE": "FTSE Bursa Malaysia KLCI", "^STI": "Straits Times", "^AXJO": "ASX 200",
    "^BSESN": "BSE Sensex",
}

CRYPTO = [
    "BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "ADA-USD", "DOGE-USD",
    "AVAX-USD", "LINK-USD", "DOT-USD", "TRX-USD", "TON11419-USD", "LTC-USD", "BCH-USD",
    "NEAR-USD", "APT-USD", "SUI20947-USD", "ARB11841-USD", "OP-USD", "ATOM-USD",
    "UNI7083-USD", "AAVE-USD", "INJ-USD", "RNDR-USD", "FET-USD", "PEPE24478-USD",
    "SHIB-USD", "HBAR-USD", "XLM-USD", "FIL-USD",
]

# Macro regime inputs (displayed in the top bar)
MACRO = {
    "^GSPC": "S&P 500", "^NDX": "Nasdaq 100", "^VIX": "VIX", "DX-Y.NYB": "US Dollar Index",
    "^TNX": "US 10Y yield", "GC=F": "Gold", "CL=F": "WTI Crude", "BTC-USD": "Bitcoin",
}

BENCH = {"stocks": "SPY", "etfs": "SPY", "indices": "^GSPC", "crypto": "BTC-USD", "forex": None}

# Forex: Yahoo ticker -> (display pair, description, group)
FOREX = {
    # Majors
    "EURUSD=X": ("EUR/USD", "Euro / US Dollar", "Major"),
    "USDJPY=X": ("USD/JPY", "US Dollar / Japanese Yen", "Major"),
    "GBPUSD=X": ("GBP/USD", "British Pound / US Dollar", "Major"),
    "USDCHF=X": ("USD/CHF", "US Dollar / Swiss Franc", "Major"),
    "AUDUSD=X": ("AUD/USD", "Australian Dollar / US Dollar", "Major"),
    "USDCAD=X": ("USD/CAD", "US Dollar / Canadian Dollar", "Major"),
    "NZDUSD=X": ("NZD/USD", "New Zealand Dollar / US Dollar", "Major"),
    # Popular crosses
    "EURGBP=X": ("EUR/GBP", "Euro / British Pound", "Cross"),
    "EURJPY=X": ("EUR/JPY", "Euro / Japanese Yen", "Cross"),
    "GBPJPY=X": ("GBP/JPY", "British Pound / Japanese Yen", "Cross"),
    "EURCHF=X": ("EUR/CHF", "Euro / Swiss Franc", "Cross"),
    "EURAUD=X": ("EUR/AUD", "Euro / Australian Dollar", "Cross"),
    "EURCAD=X": ("EUR/CAD", "Euro / Canadian Dollar", "Cross"),
    "EURNZD=X": ("EUR/NZD", "Euro / New Zealand Dollar", "Cross"),
    "GBPCHF=X": ("GBP/CHF", "British Pound / Swiss Franc", "Cross"),
    "GBPAUD=X": ("GBP/AUD", "British Pound / Australian Dollar", "Cross"),
    "GBPCAD=X": ("GBP/CAD", "British Pound / Canadian Dollar", "Cross"),
    "GBPNZD=X": ("GBP/NZD", "British Pound / New Zealand Dollar", "Cross"),
    "AUDJPY=X": ("AUD/JPY", "Australian Dollar / Japanese Yen", "Cross"),
    "AUDNZD=X": ("AUD/NZD", "Australian Dollar / New Zealand Dollar", "Cross"),
    "AUDCAD=X": ("AUD/CAD", "Australian Dollar / Canadian Dollar", "Cross"),
    "AUDCHF=X": ("AUD/CHF", "Australian Dollar / Swiss Franc", "Cross"),
    "CADJPY=X": ("CAD/JPY", "Canadian Dollar / Japanese Yen", "Cross"),
    "CHFJPY=X": ("CHF/JPY", "Swiss Franc / Japanese Yen", "Cross"),
    "NZDJPY=X": ("NZD/JPY", "New Zealand Dollar / Japanese Yen", "Cross"),
    "CADCHF=X": ("CAD/CHF", "Canadian Dollar / Swiss Franc", "Cross"),
    # Asia & emerging markets
    "MYR=X": ("USD/MYR", "US Dollar / Malaysian Ringgit", "Asia & EM"),
    "SGD=X": ("USD/SGD", "US Dollar / Singapore Dollar", "Asia & EM"),
    "HKD=X": ("USD/HKD", "US Dollar / Hong Kong Dollar", "Asia & EM"),
    "CNH=X": ("USD/CNH", "US Dollar / Chinese Yuan (offshore)", "Asia & EM"),
    "THB=X": ("USD/THB", "US Dollar / Thai Baht", "Asia & EM"),
    "IDR=X": ("USD/IDR", "US Dollar / Indonesian Rupiah", "Asia & EM"),
    "INR=X": ("USD/INR", "US Dollar / Indian Rupee", "Asia & EM"),
    "KRW=X": ("USD/KRW", "US Dollar / South Korean Won", "Asia & EM"),
    "PHP=X": ("USD/PHP", "US Dollar / Philippine Peso", "Asia & EM"),
    "SGDMYR=X": ("SGD/MYR", "Singapore Dollar / Malaysian Ringgit", "Asia & EM"),
    "ZAR=X": ("USD/ZAR", "US Dollar / South African Rand", "Asia & EM"),
    "MXN=X": ("USD/MXN", "US Dollar / Mexican Peso", "Asia & EM"),
    "TRY=X": ("USD/TRY", "US Dollar / Turkish Lira", "Asia & EM"),
    "SEK=X": ("USD/SEK", "US Dollar / Swedish Krona", "Asia & EM"),
    "NOK=X": ("USD/NOK", "US Dollar / Norwegian Krone", "Asia & EM"),
    # Metals as traded on FX platforms (Yahoo has no clean spot feed: futures used as proxy)
    "GC=F": ("XAU/USD", "Gold (front-month futures proxy)", "Metals"),
    "SI=F": ("XAG/USD", "Silver (front-month futures proxy)", "Metals"),
}
