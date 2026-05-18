"""
Solution Studio — consolidated Flask app
Supply Chain Intelligence · Manufacturing Intelligence · Finance Intelligence
Single login, shared session, one Databricks App deployment.
Routes: /supply-chain/api/... · /manufacturing/api/... · /finance/api/...
"""

import hashlib
import json
import math
import os
import random
import threading
import time
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

import requests
from flask import Flask, jsonify, redirect, request, send_from_directory, session

try:
    from databricks import sql as dbsql
    _DBSQL_OK = True
except ImportError:
    _DBSQL_OK = False

# ── Flask app ───────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")

_sk = os.getenv("SECRET_KEY") or os.getenv("DATABRICKS_TOKEN", "")
app.secret_key = _sk if _sk else hashlib.sha256(b"solution-studio-master-2024").hexdigest()

# ── Shared env vars ─────────────────────────────────────────────────────────────
DATABRICKS_HOST = os.getenv("DATABRICKS_HOST", "")
COMPANY_NAME    = os.getenv("COMPANY_NAME", "")

# Delta logging (shared)
LOG_HTTP_PATH = os.getenv("LOG_HTTP_PATH") or os.getenv("SC_SQL_WAREHOUSE_HTTP_PATH", "")
LOG_CATALOG       = os.getenv("LOG_CATALOG", "solution_studio_catalog")
LOG_SCHEMA        = os.getenv("LOG_SCHEMA", "solution_studio_logs")
LOG_SHEETS_WEBHOOK = os.getenv("LOG_SHEETS_WEBHOOK", "")

# Supply chain
SC_GENIE_SPACE_ID          = os.getenv("SC_GENIE_SPACE_ID", "")
SC_LLM_ENDPOINT            = os.getenv("SC_LLM_ENDPOINT", "databricks-meta-llama-3-3-70b-instruct")
SC_SQL_WAREHOUSE_HTTP_PATH = os.getenv("SC_SQL_WAREHOUSE_HTTP_PATH", "")

# Manufacturing
MFG_GENIE_SPACE_ID          = os.getenv("MFG_GENIE_SPACE_ID", "")
MFG_LLM_ENDPOINT            = os.getenv("MFG_LLM_ENDPOINT", "databricks-meta-llama-3-3-70b-instruct")
MFG_SQL_WAREHOUSE_HTTP_PATH = os.getenv("MFG_SQL_WAREHOUSE_HTTP_PATH", "")
MFG_UC_CATALOG              = os.getenv("MFG_UC_CATALOG", "demo_nah_catalog")
MFG_UC_SCHEMA               = os.getenv("MFG_UC_SCHEMA", "mfg_vision")
MFG_UC_VOLUME               = os.getenv("MFG_UC_VOLUME", "inspection_images")
MFG_VISION_ENDPOINT         = os.getenv("MFG_VISION_ENDPOINT", "vision")
MFG_PDM_ENDPOINT            = os.getenv("MFG_PDM_ENDPOINT", "predictive-maintenance")
MFG_MANUALS_ENDPOINT        = os.getenv("MFG_MANUALS_ENDPOINT", "mfg-manuals-rag")

# Finance
FIN_WAREHOUSE_ID   = os.getenv("FIN_WAREHOUSE_ID", "")
FIN_GENIE_SPACE_ID = os.getenv("FIN_GENIE_SPACE_ID", "")
FIN_GOOGLE_API_KEY = os.getenv("FIN_GOOGLE_API_KEY", "")
FIN_CATALOG        = os.getenv("FIN_CATALOG", "demo_nah_catalog")
FIN_GOLD_SCHEMA    = os.getenv("FIN_GOLD_SCHEMA", "finance_gold")

# ── Auth ────────────────────────────────────────────────────────────────────────
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("authenticated"):
            if "/api/" in request.path:
                return jsonify({"error": "not authenticated"}), 401
            return redirect("/login")
        return f(*args, **kwargs)
    return decorated


@app.before_request
def _auto_auth():
    """Auto-authenticate from portal launch params or Databricks platform headers."""
    if session.get("authenticated"):
        return
    auto_user    = request.args.get("auto_user",    "").strip()
    auto_company = request.args.get("auto_company", "").strip()
    auto_token   = request.args.get("auto_token",   "").strip()
    expected_tok = os.getenv("DATABRICKS_TOKEN", "")
    if auto_token and expected_tok and auto_token == expected_tok:
        session["authenticated"] = True
        session["username"]      = auto_user or "Portal User"
        session["company_name"]  = auto_company or COMPANY_NAME or "Databricks"
        return
    if auto_user and auto_company:
        session["authenticated"] = True
        session["username"]      = auto_user
        session["company_name"]  = auto_company
        return
    import re as _re
    fwd_user = (request.headers.get("X-Forwarded-User") or
                request.headers.get("X-Forwarded-Email", "")).strip()
    if fwd_user and not _re.match(r'^\d+@\d+$', fwd_user):
        session["authenticated"] = True
        session["username"]      = fwd_user
        session["company_name"]  = COMPANY_NAME or "Databricks"


# ── Credentials ─────────────────────────────────────────────────────────────────

def _creds():
    """Return (host, headers) — forwarded OAuth token preferred, env token fallback."""
    raw  = os.environ.get("DATABRICKS_HOST", "").rstrip("/")
    host = raw if raw.startswith("http") else f"https://{raw}"
    from flask import has_request_context
    user_token = request.headers.get("X-Forwarded-Access-Token", "") if has_request_context() else ""
    token = user_token or os.environ.get("DATABRICKS_TOKEN", "")
    return host, {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _genie_creds():
    """Credentials for Genie API — uses app service-principal (PAT or M2M OAuth)."""
    raw  = os.environ.get("DATABRICKS_HOST", "").rstrip("/")
    host = raw if raw.startswith("http") else f"https://{raw}"
    token = os.environ.get("DATABRICKS_TOKEN", "")
    if not token:
        client_id     = os.getenv("DATABRICKS_CLIENT_ID", "")
        client_secret = os.getenv("DATABRICKS_CLIENT_SECRET", "")
        if client_id and client_secret:
            try:
                r = requests.post(
                    f"{host}/oidc/v1/token",
                    data={"grant_type": "client_credentials", "scope": "all-apis"},
                    auth=(client_id, client_secret),
                    timeout=10,
                )
                r.raise_for_status()
                token = r.json().get("access_token", "")
            except Exception as e:
                print(f"[Genie] M2M token error: {e}", flush=True)
    return host, {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ── Delta logging ────────────────────────────────────────────────────────────────
_DELTA_LOG_OK = bool(DATABRICKS_HOST) and bool(LOG_HTTP_PATH)


def _delta_sql_exec(statement):
    host  = DATABRICKS_HOST.rstrip("/")
    token = os.getenv("DATABRICKS_TOKEN", "")
    wh_id = LOG_HTTP_PATH.rstrip("/").split("/")[-1]
    try:
        r = requests.post(
            f"{host}/api/2.0/sql/statements",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"warehouse_id": wh_id, "statement": statement, "wait_timeout": "30s"},
            timeout=35,
        )
        r.raise_for_status()
        state = r.json().get("status", {}).get("state", "")
        if state != "SUCCEEDED":
            print(f"[Delta] SQL state={state}: {r.json().get('status',{}).get('error','')}", flush=True)
            return False
        return True
    except Exception as e:
        print(f"[Delta] SQL error: {e}", flush=True)
        return False


def _delta_log_write(sql, params=()):
    if not _DELTA_LOG_OK:
        return False
    escaped = []
    for p in params:
        if isinstance(p, int):
            escaped.append(str(p))
        else:
            escaped.append("'" + str(p).replace("'", "''") + "'")
    stmt = sql % tuple(escaped) if escaped else sql
    return _delta_sql_exec(stmt)


def _sheets_log_write(data: dict):
    if not LOG_SHEETS_WEBHOOK:
        return False
    try:
        requests.post(LOG_SHEETS_WEBHOOK, json=data, timeout=10)
        return True
    except Exception as e:
        print(f"[Sheets] Write failed: {e}", flush=True)
        return False


def _ensure_log_tables():
    if not _DELTA_LOG_OK:
        return
    _delta_sql_exec(f"CREATE SCHEMA IF NOT EXISTS {LOG_CATALOG}.{LOG_SCHEMA}")
    _delta_sql_exec(
        f"CREATE TABLE IF NOT EXISTS {LOG_CATALOG}.{LOG_SCHEMA}.page_time_log "
        "(username STRING, company_name STRING, page STRING, "
        "seconds_spent INT, app_name STRING, recorded_at TIMESTAMP) USING DELTA"
    )
    _delta_sql_exec(
        f"CREATE TABLE IF NOT EXISTS {LOG_CATALOG}.{LOG_SCHEMA}.contact_submissions "
        "(name STRING, company STRING, email STRING, role STRING, "
        "interest STRING, message STRING, submitted_at TIMESTAMP) USING DELTA"
    )
    print("[Delta] Log tables ready", flush=True)


_ensure_log_tables()

# ── Utilities ───────────────────────────────────────────────────────────────────
_DAY_SEED = int(time.time() / 86400)
_rng      = random.Random(_DAY_SEED)


def _j(base, pct=0.02):
    """Small daily jitter — numbers feel live but stay consistent per day."""
    return base * (1 + (_rng.random() - 0.5) * pct * 2)


# ══════════════════════════════════════════════════════════════════════════════
# PORTAL ROUTES
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    if not session.get("authenticated"):
        return redirect("/login")
    return redirect("/portal")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        auto_user    = request.args.get("auto_user", "").strip()
        auto_company = request.args.get("auto_company", "").strip()
        if auto_user and auto_company:
            session["authenticated"] = True
            session["username"]      = auto_user
            session["company_name"]  = auto_company
            return redirect("/portal")
        return send_from_directory(str(STATIC_DIR), "login.html")
    # POST
    username     = (request.form.get("username") or "").strip()
    company_name = (request.form.get("password") or "").strip()
    if username and company_name:
        session["authenticated"] = True
        session["username"]      = username
        session["company_name"]  = company_name
        return redirect("/portal")
    return send_from_directory(str(STATIC_DIR), "login.html"), 401


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")


@app.route("/health")
def health():
    try:
        outbound_ip = requests.get("https://api.ipify.org?format=json", timeout=5).json().get("ip", "unknown")
    except Exception:
        outbound_ip = "unknown"
    return jsonify({"status": "ok", "delta_log": "enabled" if _DELTA_LOG_OK else "disabled", "outbound_ip": outbound_ip})


@app.route("/portal")
@login_required
def portal():
    return send_from_directory(str(STATIC_DIR), "portal.html")


@app.route("/api/config")
@login_required
def config():
    apps = [
        {
            "name":     os.getenv("APP_1_NAME",     "Supply Chain Intelligence"),
            "tagline":  os.getenv("APP_1_TAGLINE",  "IBP · Inventory · Demand · Orders"),
            "desc":     os.getenv("APP_1_DESC",     "Supply chain leaders face mounting pressure from tariff volatility, supplier disruptions, and demand uncertainty. This app gives S&OP and procurement teams a unified command center — AI-driven demand sensing, real-time inventory visibility, and automated exception management to protect margins and service levels."),
            "url":      "/supply-chain/",
            "features": os.getenv("APP_1_FEATURES", "Integrated Business Planning,Inventory Optimization,Demand Forecasting AI,Order Automation").split(","),
            "badge":    os.getenv("APP_1_BADGE",    "Supply Chain"),
            "color":    os.getenv("APP_1_COLOR",    "#1B6FEB"),
        },
        {
            "name":     os.getenv("APP_2_NAME",     "Manufacturing Intelligence"),
            "tagline":  os.getenv("APP_2_TAGLINE",  "OEE · Quality · Predictive Maintenance"),
            "desc":     os.getenv("APP_2_DESC",     "Plant managers and reliability engineers lose millions annually to unplanned downtime and quality escapes. This app unifies machine telemetry, vision-based defect detection, and predictive maintenance into a single real-time view — reducing unplanned downtime, cutting scrap rates, and shifting maintenance from reactive to predictive."),
            "url":      "/manufacturing/",
            "features": os.getenv("APP_2_FEATURES", "OEE Monitoring,Predictive Maintenance,Defect Detection AI,Quality Analytics").split(","),
            "badge":    os.getenv("APP_2_BADGE",    "Manufacturing"),
            "color":    os.getenv("APP_2_COLOR",    "#10b981"),
        },
        {
            "name":     os.getenv("APP_3_NAME",     "Finance Intelligence"),
            "tagline":  os.getenv("APP_3_TAGLINE",  "P&L · Cash Flow · Forecasting · Risk"),
            "desc":     os.getenv("APP_3_DESC",     "CFOs and FP&A teams are flying blind when financial data is fragmented across ERPs, spreadsheets, and business units. This app consolidates P&L, cash flow, and cost center data into a live finance command center — enabling faster close cycles, AI-generated executive briefings, and proactive risk detection before it hits the bottom line."),
            "url":      "/finance/",
            "features": os.getenv("APP_3_FEATURES", "P&L Visibility,Cash Flow Forecasting,Variance Analysis,Risk Detection AI").split(","),
            "badge":    os.getenv("APP_3_BADGE",    "Finance"),
            "color":    os.getenv("APP_3_COLOR",    "#f59e0b"),
        },
    ]
    return jsonify({
        "company_name": session.get("company_name", COMPANY_NAME),
        "username":     session.get("username", ""),
        "launch_token": os.getenv("DATABRICKS_TOKEN", ""),
        "apps":         apps,
    })


@app.route("/api/contact", methods=["POST"])
@login_required
def contact():
    data     = request.get_json(silent=True) or {}
    name     = str(data.get("name",     ""))[:120]
    company  = str(data.get("company",  ""))[:120]
    email    = str(data.get("email",    session.get("email", "")))[:120]
    role     = str(data.get("role",     ""))[:120]
    interest = str(data.get("interest", ""))[:120]
    message  = str(data.get("message",  ""))[:1000]
    stored = _delta_log_write(
        f"INSERT INTO {LOG_CATALOG}.{LOG_SCHEMA}.contact_submissions "
        "(name, company, email, role, interest, message, submitted_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, current_timestamp())",
        (name, company, email, role, interest, message),
    )
    _sheets_log_write({"type": "contact", "username": name, "company_name": company,
                       "email": email, "role": role, "interest": interest, "message": message})
    return jsonify({"status": "ok", "stored": stored})


# ══════════════════════════════════════════════════════════════════════════════
# SUPPLY CHAIN — /supply-chain/
# ══════════════════════════════════════════════════════════════════════════════

_SC_MONTHS_HIST = [
    "Jun-24", "Jul-24", "Aug-24", "Sep-24", "Oct-24", "Nov-24",
    "Dec-24", "Jan-25", "Feb-25", "Mar-25", "Apr-25", "May-25",
]
_SC_MONTHS_FWD = ["Jun-25", "Jul-25", "Aug-25", "Sep-25", "Oct-25", "Nov-25"]
_SC_ALL_MONTHS = _SC_MONTHS_HIST + _SC_MONTHS_FWD

_action_status: dict[str, str] = {}


@app.route("/supply-chain/")
@login_required
def sc_index():
    return send_from_directory(str(STATIC_DIR / "supply-chain"), "index.html")


@app.route("/supply-chain/api/kpis")
@login_required
def sc_kpis():
    return jsonify({
        "plan_attainment":  round(_j(91.4), 1),
        "inventory_turns":  round(_j(8.4),  1),
        "forecast_mape":    round(_j(9.1),  1),
        "order_automation": round(_j(78.4), 1),
        "on_time_delivery": round(_j(91.3), 1),
        "fill_rate":        round(_j(97.2), 1),
        "excess_value_m":   round(_j(12.4), 1),
        "open_exceptions":  47,
    })


@app.route("/supply-chain/api/ibp")
@login_required
def sc_ibp():
    rng = random.Random(_DAY_SEED + 1)
    _seasonal = {
        'Jan': 0.84, 'Feb': 0.87, 'Mar': 0.93, 'Apr': 0.97,
        'May': 1.00, 'Jun': 0.96, 'Jul': 0.91, 'Aug': 0.95,
        'Sep': 1.01, 'Oct': 1.06, 'Nov': 1.09, 'Dec': 1.13,
    }
    plan_data = []
    base, asp_m = 138.0, 0.00045
    for m in _SC_ALL_MONTHS:
        seasonal  = _seasonal.get(m[:3], 1.0)
        consensus = round(_j(base * seasonal) * (1 + (rng.random() - 0.5) * 0.04), 1)
        financial = round(consensus * (1 + rng.random() * 0.04), 1)
        capacity  = round(financial * (1.05 + rng.random() * 0.02), 1)
        plan_data.append({
            "month": m, "consensus": consensus, "financial": financial,
            "capacity": capacity,
            "consensus_k": round(consensus / asp_m / 1000),
            "financial_k": round(financial / asp_m / 1000),
            "capacity_k":  round(capacity  / asp_m / 1000),
            "is_future":   m in _SC_MONTHS_FWD,
        })
    sop_stages = [
        {"stage": "Data Collection",      "status": "complete",    "owner": "Finance & Ops",   "date": "Apr 28"},
        {"stage": "Statistical Forecast", "status": "complete",    "owner": "Demand Planning", "date": "Apr 30"},
        {"stage": "Unconstrained Demand", "status": "complete",    "owner": "Commercial",      "date": "May 2"},
        {"stage": "Supply Review",        "status": "in_progress", "owner": "Supply Chain",    "date": "May 7"},
        {"stage": "Consensus Meeting",    "status": "pending",     "owner": "S&OP Team",       "date": "May 12"},
        {"stage": "Executive Sign-off",   "status": "pending",     "owner": "Leadership",      "date": "May 14"},
    ]
    bus = [
        {"bu": "North America", "attainment": round(_j(94.2), 1), "target": 95.0},
        {"bu": "EMEA",          "attainment": round(_j(88.7), 1), "target": 92.0},
        {"bu": "APAC",          "attainment": round(_j(91.3), 1), "target": 90.0},
        {"bu": "Latin America", "attainment": round(_j(86.1), 1), "target": 88.0},
        {"bu": "Rest of World", "attainment": round(_j(79.4), 1), "target": 85.0},
    ]
    risks = [
        {"item": "EMEA capacity shortfall Q3",                    "impact": "High",   "value_m": 4.2, "owner": "S. Kowalski"},
        {"item": "Asia-Pac port congestion — inbound delay +3wk", "impact": "High",   "value_m": 2.8, "owner": "T. Nguyen"},
        {"item": "Key component lead time extended +4 weeks",     "impact": "Medium", "value_m": 1.9, "owner": "R. Patel"},
        {"item": "Q4 demand spike not captured in consensus",     "impact": "Medium", "value_m": 3.1, "owner": "M. Chen"},
        {"item": "New product launch timing uncertainty",         "impact": "Low",    "value_m": 0.7, "owner": "A. Davies"},
    ]
    return jsonify({
        "plan_data": plan_data, "sop_stages": sop_stages,
        "bu_attainment": bus, "risks": risks,
        "kpis": {
            "plan_attainment":   round(_j(91.4), 1),
            "forecast_accuracy": round(_j(87.3), 1),
            "consensus_rate":    round(_j(94.1), 1),
            "cycle_days":        14,
        },
    })


@app.route("/supply-chain/api/inventory")
@login_required
def sc_inventory():
    warehouses = [
        {"name": "Chicago DC",   "code": "ORD", "utilization": round(_j(87), 1), "skus": 1842, "dos": round(_j(32), 1), "region": "North America"},
        {"name": "Dallas DC",    "code": "DFW", "utilization": round(_j(74), 1), "skus": 1421, "dos": round(_j(28), 1), "region": "North America"},
        {"name": "Rotterdam DC", "code": "RTM", "utilization": round(_j(91), 1), "skus": 2103, "dos": round(_j(41), 1), "region": "EMEA"},
        {"name": "Singapore DC", "code": "SIN", "utilization": round(_j(68), 1), "skus": 1654, "dos": round(_j(24), 1), "region": "APAC"},
        {"name": "Monterrey DC", "code": "MTY", "utilization": round(_j(82), 1), "skus":  987, "dos": round(_j(36), 1), "region": "Latin America"},
    ]
    categories = [
        {"name": "Finished Goods",   "dos": round(_j(38), 1), "lo": 25, "hi": 45, "value_m": 48.2},
        {"name": "Work in Progress", "dos": round(_j(12), 1), "lo":  8, "hi": 18, "value_m": 22.7},
        {"name": "Raw Materials",    "dos": round(_j(52), 1), "lo": 30, "hi": 60, "value_m": 31.4},
        {"name": "Packaging",        "dos": round(_j(67), 1), "lo": 30, "hi": 60, "value_m":  8.1},
        {"name": "MRO",              "dos": round(_j(91), 1), "lo": 45, "hi": 90, "value_m":  5.3},
    ]
    health = {"optimal": 4823, "excess": 891, "at_risk": 412, "stockout": 121}
    alerts = [
        {"sku": "FG-78421", "desc": "Premium Sprocket Assembly", "dos": 187, "value_k": 284, "location": "Chicago DC",   "type": "excess"},
        {"sku": "RM-34892", "desc": "Alloy Steel Rod 25mm",      "dos": 143, "value_k": 142, "location": "Rotterdam DC", "type": "excess"},
        {"sku": "FG-91033", "desc": "Drive Belt Assembly XL",    "dos":   3, "value_k":  67, "location": "Singapore DC", "type": "stockout"},
        {"sku": "PKG-2201", "desc": "Corrugated Box 48×36",      "dos": 128, "value_k":  38, "location": "Dallas DC",    "type": "excess"},
        {"sku": "FG-55102", "desc": "Hydraulic Pump Unit",       "dos":   4, "value_k": 421, "location": "Chicago DC",   "type": "stockout"},
        {"sku": "WIP-7742", "desc": "Sub-Assembly Module B",     "dos":   6, "value_k":  93, "location": "Monterrey DC", "type": "at_risk"},
    ]
    return jsonify({
        "warehouses": warehouses, "categories": categories,
        "health": health, "alerts": alerts,
        "kpis": {
            "inventory_turns": round(_j(8.4),  1),
            "days_on_hand":    round(_j(43),   1),
            "fill_rate":       round(_j(97.2), 1),
            "excess_value_m":  round(_j(12.4), 1),
        },
    })


@app.route("/supply-chain/api/demand")
@login_required
def sc_demand():
    rng  = random.Random(_DAY_SEED + 3)
    base = 144_000
    _over_reasons = [
        "Planned promotional uplift did not materialise — retailer pulled forward volume to prior period.",
        "Customer order consolidation shifted demand to Q+1; two large accounts delayed releases.",
        "New product launch cannibalized existing SKU volumes faster than the model anticipated.",
        "EMEA industrial demand softer than modelled — energy cost headwinds reduced customer run rates.",
        "Sales pipeline conversion rate dropped; three key opportunities pushed to the following month.",
        "Logistics disruption caused a shipment timing shift — fulfilled in an adjacent period.",
    ]
    _under_reasons = [
        "Competitor supply disruption drove an unexpected surge — three new accounts won mid-month.",
        "Promotional campaign outperformed plan by 18%; higher-than-forecast retailer pull-through.",
        "Q-end customer stocking behaviour — multiple accounts accelerated orders ahead of a price increase.",
        "New product fill orders exceeded expectations; initial channel inventory build 22% above forecast.",
        "Unmodelled incremental export volume from APAC distributor placed a large spot order.",
        "Seasonal demand arrived three weeks earlier than historical pattern, pulling volume from next month.",
    ]
    _flat_reasons = [
        "Forecast was within normal variance; model performance within ±3% for the period.",
        "Demand planners applied a small upward override that proved accurate for this month.",
        "Statistical model captured seasonal pattern well; no significant demand events this period.",
    ]
    fa_data = []
    for i, m in enumerate(_SC_MONTHS_HIST):
        trend  = 1 + i * 0.008
        actual = round(_j(base * trend, 0.04))
        fc     = round(actual * (1 + (rng.random() - 0.5) * 0.1))
        bias   = (fc - actual) / actual * 100
        if bias > 3:
            reason = _over_reasons[i % len(_over_reasons)]
        elif bias < -3:
            reason = _under_reasons[i % len(_under_reasons)]
        else:
            reason = _flat_reasons[i % len(_flat_reasons)]
        fa_data.append({"month": m, "forecast": fc, "actual": actual, "reason": reason})
    cat_mape = [
        {"category": "Finished Goods",  "mape": round(_j(8.2),  1), "bias": round(_j(-1.4, 0.3), 1), "skus": 1842},
        {"category": "Components",      "mape": round(_j(11.4), 1), "bias": round(_j(-3.2, 0.3), 1), "skus": 2401},
        {"category": "Raw Materials",   "mape": round(_j(14.7), 1), "bias": round(_j( 2.1, 0.3), 1), "skus":  842},
        {"category": "Packaging",       "mape": round(_j(7.8),  1), "bias": round(_j(-0.8, 0.3), 1), "skus":  963},
        {"category": "MRO",             "mape": round(_j(22.1), 1), "bias": round(_j( 5.3, 0.3), 1), "skus":  200},
    ]
    _sku_defs = [
        {"sku": "FG-55102", "desc": "Hydraulic Pump Unit",       "mape": 34.2, "bias": -28.1, "last_actual":  842, "base":  820, "vol": 0.06, "bias_pct": -0.28, "trend": 0.010},
        {"sku": "FG-78421", "desc": "Premium Sprocket Assembly", "mape": 28.7, "bias":  22.4, "last_actual": 1204, "base": 1150, "vol": 0.05, "bias_pct":  0.22, "trend": 0.006},
        {"sku": "CP-33901", "desc": "Control Module Type C",     "mape": 24.1, "bias": -19.8, "last_actual": 3401, "base": 3200, "vol": 0.04, "bias_pct": -0.19, "trend": 0.008},
        {"sku": "RM-44211", "desc": "Titanium Sheet 2mm",        "mape": 21.8, "bias":  18.2, "last_actual":  621, "base":  600, "vol": 0.05, "bias_pct":  0.18, "trend": 0.005},
        {"sku": "FG-91033", "desc": "Drive Belt Assembly XL",    "mape": 19.4, "bias": -16.7, "last_actual": 2804, "base": 2650, "vol": 0.04, "bias_pct": -0.16, "trend": 0.009},
    ]
    sku_rng    = random.Random(_DAY_SEED + 7)
    top_errors = []
    for sd in _sku_defs:
        history = []
        for i, m in enumerate(_SC_MONTHS_HIST):
            actual = round(sd["base"] * (1 + i * sd["trend"]) * (1 + (sku_rng.random() - 0.5) * sd["vol"]))
            fc     = round(actual * (1 + sd["bias_pct"] + (sku_rng.random() - 0.5) * 0.06))
            history.append({"month": m, "forecast": fc, "actual": actual})
        top_errors.append({"sku": sd["sku"], "desc": sd["desc"], "mape": sd["mape"],
                           "bias": sd["bias"], "last_actual": sd["last_actual"], "history": history})
    mape_trend = [{"month": m, "mape": round(_j(9.1 + (5 - i) * 0.42, 0.04), 1)}
                  for i, m in enumerate(_SC_MONTHS_HIST)]
    return jsonify({
        "forecast_vs_actual": fa_data,
        "category_mape":      cat_mape,
        "top_errors":         top_errors,
        "mape_trend":         mape_trend,
        "kpis": {
            "mape":               round(_j(9.1),  1),
            "bias":               round(_j(-2.3, 0.1), 1),
            "forecast_value_add": round(_j(12.4), 1),
            "skus_forecast":      6248,
        },
    })


@app.route("/supply-chain/api/orders")
@login_required
def sc_orders():
    exceptions = [
        {
            "type": "Price Discrepancy", "count": 23, "aging_days": round(_j(4.2), 1),
            "value_k": 184, "priority": "high",
            "root_cause": "18 of 23 POs are from Pacific Components where the Q2 contract renewal has not been loaded into ERP — system is applying the expired Q1 rate card. The remaining 5 relate to EUR/USD FX rate mismatches on European supplier invoices.",
            "recommendations": [
                {"action": "Load renewed Pacific Components rate card into ERP contract master (Item: PSUP-CONTRACT-2024-Q2). This resolves 18 POs and releases $143K automatically.", "type": "auto", "impact": "High"},
                {"action": "Run FX rate refresh job for EUR-denominated POs. Three Precision Parts GmbH POs will auto-resolve once the daily FX feed is applied.", "type": "auto", "impact": "Medium"},
                {"action": "Escalate 2 remaining POs (PO-84421, PO-84438) to the procurement manager — supplier is disputing the agreed unit price for SKU-CP-301.", "type": "manual", "impact": "Low"},
            ],
            "pos": [
                {"po": "PO-84401", "supplier": "Pacific Components",    "material": "Control Module Type C", "value_k": 12.4, "age_days": 5, "issue": "Contract rate gap — ERP applying Q1 price $41.20 vs agreed Q2 price $38.50"},
                {"po": "PO-84408", "supplier": "Pacific Components",    "material": "Drive Unit D",           "value_k": 18.2, "age_days": 6, "issue": "Contract rate gap — ERP applying Q1 price $41.20 vs agreed Q2 price $38.50"},
                {"po": "PO-84421", "supplier": "Pacific Components",    "material": "Cable Harness J",        "value_k":  5.3, "age_days": 7, "issue": "Disputed unit price — supplier invoice $71.50 vs PO $68.00; under negotiation"},
                {"po": "PO-84429", "supplier": "Precision Parts GmbH", "material": "Hydraulic Valve B",      "value_k": 14.6, "age_days": 2, "issue": "EUR/USD FX mismatch — invoice converted at 1.072, PO created at 1.089"},
            ],
        },
        {
            "type": "Delivery Date Mismatch", "count": 11, "aging_days": round(_j(2.8), 1),
            "value_k": 92, "priority": "medium",
            "root_cause": "Suppliers confirmed ETDs 4–12 days later than PO-required delivery dates. 4 POs from Acero del Norte are delayed due to a Mexican customs hold. 3 EuroTech POs are affected by a Rotterdam port backlog.",
            "recommendations": [
                {"action": "Contact Acero del Norte logistics coordinator to confirm updated ETD for PO-91201 through PO-91204. Request ASN update in portal by EOD.", "type": "manual", "impact": "High"},
                {"action": "For EuroTech POs, switch carrier from sea to air freight for PO-91208 (Pump Assembly F, $31K). Air premium ~$2.1K vs $14K stockout risk.", "type": "auto", "impact": "Medium"},
                {"action": "Enable ERP alert rule: flag any supplier ASN that deviates >3 days from PO delivery date within 24 hours of ASN submission.", "type": "auto", "impact": "Medium"},
            ],
            "pos": [
                {"po": "PO-91201", "supplier": "Acero del Norte",   "material": "Frame Component H", "value_k": 18.7, "age_days": 3, "issue": "Customs hold at Monterrey port — new ETD May 19 vs PO req May 14"},
                {"po": "PO-91207", "supplier": "EuroTech Supplies", "material": "Pump Assembly F",   "value_k": 31.4, "age_days": 2, "issue": "Rotterdam port backlog — vessel delayed 6 days"},
                {"po": "PO-91211", "supplier": "Allied Materials",  "material": "Actuator M",        "value_k": 10.5, "age_days": 1, "issue": "Supplier capacity constraint — production line maintenance pushed ETD 4 days"},
            ],
        },
        {
            "type": "Missing PO Reference", "count": 7, "aging_days": round(_j(6.1), 1),
            "value_k": 41, "priority": "high",
            "root_cause": "4 POs were created via the legacy procurement portal during the ERP migration window and were not assigned system PO numbers. 3 POs are from a newly onboarded supplier (Nordic Components) whose EDI connection was not yet live.",
            "recommendations": [
                {"action": "Run ERP auto-assignment script for the 4 migration-window POs (PO-MIGR-001 through 004).", "type": "auto", "impact": "High"},
                {"action": "Manually assign PO references for 3 Nordic Components POs and notify supplier.", "type": "manual", "impact": "Medium"},
                {"action": "Activate Nordic Components EDI connection (IT ticket #IT-4421 is open).", "type": "manual", "impact": "Medium"},
            ],
            "pos": [
                {"po": "PO-MIGR-001", "supplier": "Apex Industrial",   "material": "Control Module A", "value_k":  8.4, "age_days": 7, "issue": "Created via legacy portal during ERP migration — no system PO number assigned"},
                {"po": "PO-NC-001",   "supplier": "Nordic Components", "material": "PCB Module G",     "value_k":  7.8, "age_days": 5, "issue": "New supplier — EDI not live at order creation"},
                {"po": "PO-NC-002",   "supplier": "Nordic Components", "material": "Display Panel N",  "value_k":  6.4, "age_days": 5, "issue": "New supplier — EDI connection pending IT ticket #IT-4421"},
            ],
        },
        {
            "type": "Quantity Variance >5%", "count": 4, "aging_days": round(_j(3.4), 1),
            "value_k": 218, "priority": "medium",
            "root_cause": "All 4 POs involve short shipments from Pacific Components. Received quantities are 8–22% below PO quantities due to a raw material allocation constraint at the supplier's Shenzhen facility.",
            "recommendations": [
                {"action": "Accept partial receipts and raise a new expedite PO for the shortfall quantities with a 10-day lead time commitment.", "type": "manual", "impact": "High"},
                {"action": "Trigger emergency replenishment for SKU-CP-301 — current DOS is 6 days, below the 7-day at-risk threshold.", "type": "auto", "impact": "High"},
                {"action": "Dual-source SKU-CP-301 and SKU-DA-410 to eliminate single-source dependency. RFQ to 2 alternative suppliers in 48 hours.", "type": "manual", "impact": "Low"},
            ],
            "pos": [
                {"po": "PO-77301", "supplier": "Pacific Components", "material": "Drive Unit D",    "value_k": 82.5, "age_days": 4, "issue": "Short shipment — ordered 250 units, received 195 (22% short)."},
                {"po": "PO-77308", "supplier": "Pacific Components", "material": "Control Module A","value_k": 68.4, "age_days": 3, "issue": "Short shipment — ordered 480 units, received 432 (10% short)."},
                {"po": "PO-77315", "supplier": "Pacific Components", "material": "Sensor Array C",  "value_k": 42.1, "age_days": 3, "issue": "Short shipment — ordered 200 units, received 164 (18% short)."},
            ],
        },
        {
            "type": "Unmatched Invoice", "count": 2, "aging_days": round(_j(8.7), 1),
            "value_k": 67, "priority": "high",
            "root_cause": "Invoice INV-AP-8841 arrived before the goods receipt was posted. Invoice INV-AP-8857 has a PO number typo (PO-84O33 vs PO-84033) which broke automated matching.",
            "recommendations": [
                {"action": "Post goods receipt for PO-84029 in ERP — goods are in warehouse, receipt not yet confirmed.", "type": "manual", "impact": "High"},
                {"action": "Correct PO reference on INV-AP-8857 from PO-84O33 to PO-84033 and resubmit through AP matching.", "type": "auto", "impact": "High"},
            ],
            "pos": [
                {"po": "PO-84029", "supplier": "Allied Materials", "material": "Actuator M",     "value_k": 38.0, "age_days": 9, "issue": "Invoice INV-AP-8841 received before goods receipt posted."},
                {"po": "PO-84033", "supplier": "Europart GmbH",    "material": "Pump Assembly F","value_k": 29.0, "age_days": 8, "issue": "Invoice INV-AP-8857 has PO reference typo — letter O vs digit 0."},
            ],
        },
    ]
    suppliers = [
        {"name": "Apex Industrial",      "otd": round(_j(96.4), 1), "pos": 142, "spend_m": 8.4,  "country": "USA"},
        {"name": "Precision Parts GmbH", "otd": round(_j(91.8), 1), "pos":  89, "spend_m": 6.2,  "country": "Germany"},
        {"name": "Pacific Components",   "otd": round(_j(88.2), 1), "pos": 203, "spend_m": 11.7, "country": "China"},
        {"name": "Acero del Norte",      "otd": round(_j(84.7), 1), "pos":  67, "spend_m": 4.1,  "country": "Mexico"},
        {"name": "Allied Materials",     "otd": round(_j(93.1), 1), "pos": 118, "spend_m": 7.8,  "country": "USA"},
        {"name": "EuroTech Supplies",    "otd": round(_j(79.3), 1), "pos":  54, "spend_m": 3.2,  "country": "Netherlands"},
    ]
    order_vol = [{"month": m, "total": (t := round(_j(2840 + i * 40, 0.04))),
                  "automated": (a := round(t * _j(0.784, 0.03))), "manual": t - a}
                 for i, m in enumerate(_SC_MONTHS_HIST)]
    auto_trend = [{"month": m, "rate": round(_j(78.4 - (11 - i) * 0.7, 0.02), 1)}
                  for i, m in enumerate(_SC_MONTHS_HIST)]
    return jsonify({
        "exceptions": exceptions, "suppliers": suppliers,
        "order_volume": order_vol, "automation_trend": auto_trend,
        "kpis": {
            "automation_rate":  round(_j(78.4), 1),
            "avg_cycle_hours":  round(_j(4.2),  1),
            "exceptions_open":  47,
            "on_time_delivery": round(_j(91.3), 1),
        },
    })


# ── Supply chain AI chat helpers ─────────────────────────────────────────────────
_SC_FALLBACK_RESPONSES = [
    {
        "keywords": ["ibp", "plan", "s&op", "consensus", "attainment"],
        "answer": "The current S&OP cycle shows plan attainment at **91.4%** against a 95% target. The key gap is EMEA (88.7%) driven by a Q3 capacity shortfall worth $4.2M. The consensus meeting is gated for May 12th.",
        "follow_ups": ["What is the financial impact of the EMEA capacity gap?", "Which BU is furthest from plan attainment target?"],
    },
    {
        "keywords": ["inventory", "stock", "dos", "excess", "stockout", "warehouse"],
        "answer": "Current inventory: **121 stockouts** and **$12.4M in excess stock**. The most critical stockout is FG-55102 (Hydraulic Pump Unit) at 4 DOS in Chicago DC. Rotterdam DC is at 91% utilization.",
        "follow_ups": ["Which DCs are at capacity risk this quarter?", "Show me all stockout SKUs in APAC."],
    },
    {
        "keywords": ["forecast", "demand", "mape", "bias", "accuracy"],
        "answer": "Overall MAPE is **9.1%** — just inside the 10% target. MRO is the outlier at 22.1%. A systematic -2.3% under-forecast bias across Finished Goods means you are consistently running leaner than planned.",
        "follow_ups": ["What is driving the MRO forecast error?", "Which SKUs improved the most in MAPE last quarter?"],
    },
    {
        "keywords": ["order", "po", "purchase", "automation", "exception", "supplier"],
        "answer": "Order automation is running at **78.4%**, up from 71.2% six months ago. The **23 price discrepancy exceptions** represent $184K in held orders — 18 are from Pacific Components where a contract renewal is pending.",
        "follow_ups": ["Which supplier has the worst on-time delivery?", "How much revenue is blocked by open exceptions?"],
    },
]
_SC_DEFAULT_RESPONSE = {
    "answer": "Based on your supply chain data: plan attainment is **91.4%**, inventory shows 121 stockouts and $12.4M excess, MAPE is **9.1%**, and order automation is at **78.4%**. Which area would you like to explore?",
    "follow_ups": ["What is the financial impact of the EMEA capacity gap?", "Which supplier is causing the most order exceptions?"],
}


def _pick_fallback(question: str) -> dict:
    q, best, best_score = question.lower(), _SC_DEFAULT_RESPONSE, 0
    for item in _SC_FALLBACK_RESPONSES:
        score = sum(1 for kw in item["keywords"] if kw in q)
        if score > best_score:
            best_score, best = score, item
    return best


_ACTIONS = [
    {"id": "ACT-001", "type": "emergency_reorder",   "entity_id": "FG-55102", "entity_name": "Hydraulic Pump Unit",        "label": "Emergency Reorder",          "description": "Trigger emergency reorder for FG-55102 — 4 DOS remaining in Chicago DC.", "rationale": "Systematic -28% under-forecast bias has depleted safety stock.", "impact_usd": 421000, "priority": "Critical", "owner": "Supply Chain Ops", "status": "pending", "keywords": ["fg-55102","hydraulic pump","stockout","chicago","reorder"]},
    {"id": "ACT-002", "type": "lateral_transfer",    "entity_id": "FG-78421", "entity_name": "Premium Sprocket Assembly",   "label": "Lateral Transfer",           "description": "Transfer 200 units FG-78421 from Chicago DC → Rotterdam DC (91% utilization).", "rationale": "Chicago has 187 DOS excess. Rotterdam at capacity risk.", "impact_usd": 284000, "priority": "High",     "owner": "Logistics",        "status": "pending", "keywords": ["fg-78421","sprocket","rotterdam","excess","chicago","transfer"]},
    {"id": "ACT-003", "type": "update_contract",     "entity_id": "PSUP-PACIFIC", "entity_name": "Pacific Components",     "label": "Load Q2 Rate Card",          "description": "Load renewed Q2 contract rate card into ERP to auto-resolve 18 held POs ($143K).", "rationale": "ERP applying expired Q1 price $41.20 vs agreed Q2 rate $38.50.", "impact_usd": 143000, "priority": "High",     "owner": "Procurement",      "status": "pending", "keywords": ["pacific components","price discrepancy","rate card","contract","exceptions"]},
    {"id": "ACT-004", "type": "expedite_shipment",   "entity_id": "PO-91207",  "entity_name": "EuroTech — Pump Assembly F","label": "Expedite to Air Freight",    "description": "Switch PO-91207 from sea to air freight — Rotterdam port backlog causing 6-day delay.", "rationale": "Air premium ~$2.1K vs $14K stockout risk.", "impact_usd": 14000,  "priority": "High",     "owner": "Logistics",        "status": "pending", "keywords": ["po-91207","eurotech","rotterdam","delivery","delay","expedite"]},
    {"id": "ACT-005", "type": "post_goods_receipt",  "entity_id": "PO-84029",  "entity_name": "Allied Materials — Actuator M","label": "Post Goods Receipt",      "description": "Post goods receipt for PO-84029 — goods confirmed in WH-01, ERP receipt pending.", "rationale": "Unblocks invoice INV-AP-8841 ($38K) for 3-way match.", "impact_usd": 38000,  "priority": "Medium",   "owner": "Warehouse Ops",    "status": "pending", "keywords": ["po-84029","allied","invoice","unmatched","goods receipt"]},
    {"id": "ACT-006", "type": "adjust_forecast",     "entity_id": "FG-55102",  "entity_name": "Hydraulic Pump Unit",        "label": "Apply Forecast Override +28%","description": "Apply +28% upward override to FG-55102 consensus forecast to correct persistent under-bias.", "rationale": "34.2% MAPE, -28% systematic bias over 12 months.", "impact_usd": 0,      "priority": "Medium",   "owner": "Demand Planning",  "status": "pending", "keywords": ["fg-55102","forecast","mape","bias","demand"]},
    {"id": "ACT-007", "type": "dual_source",         "entity_id": "CP-33901",  "entity_name": "Control Module Type C",      "label": "Initiate Dual-Source RFQ",   "description": "Issue RFQ to 2 alternative suppliers for CP-33901 to reduce single-source risk.", "rationale": "Pacific Components short-shipped 4 POs. $218K at risk.", "impact_usd": 218000, "priority": "Medium",   "owner": "Procurement",      "status": "pending", "keywords": ["cp-33901","control module","pacific","quantity variance","rfq"]},
    {"id": "ACT-008", "type": "safety_stock_review", "entity_id": "FG-91033",  "entity_name": "Drive Belt Assembly XL",     "label": "Review Safety Stock Policy", "description": "Increase safety stock policy for FG-91033 — currently 3 DOS in Singapore DC.", "rationale": "Below 7-day at-risk threshold. 19.4% MAPE with -16.7% bias.", "impact_usd": 67000,  "priority": "Medium",   "owner": "Supply Planning",  "status": "pending", "keywords": ["fg-91033","drive belt","singapore","stockout","safety stock"]},
    {"id": "ACT-009", "type": "capacity_escalation", "entity_id": "EMEA",      "entity_name": "EMEA Business Unit",         "label": "Escalate EMEA to S&OP",      "description": "Escalate EMEA Q3 capacity shortfall ($4.2M) to S&OP Executive Review before May 12.", "rationale": "88.7% attainment vs 92% target.", "impact_usd": 4200000,"priority": "High",     "owner": "S&OP",             "status": "pending", "keywords": ["emea","capacity","attainment","s&op","ibp","plan"]},
    {"id": "ACT-010", "type": "fx_rate_refresh",     "entity_id": "PSUP-PRECISION","entity_name": "Precision Parts GmbH",  "label": "Run FX Rate Refresh",        "description": "Run FX rate refresh job for EUR-denominated POs from Precision Parts GmbH (3 POs, $23.5K).", "rationale": "EUR/USD mismatch: invoices at 1.072 vs PO rate 1.089.", "impact_usd": 23500,  "priority": "Low",      "owner": "Finance",          "status": "pending", "keywords": ["precision parts","fx","eur","currency","invoice"]},
]


@app.route("/supply-chain/api/ai-chat", methods=["POST"])
@login_required
def sc_ai_chat():
    data     = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    if not question:
        return jsonify({"error": "question required"}), 400
    if SC_GENIE_SPACE_ID:
        try:
            host, hdrs = _genie_creds()
            r1 = requests.post(
                f"{host}/api/2.0/genie/spaces/{SC_GENIE_SPACE_ID}/start-conversation",
                headers=hdrs, json={"content": question}, timeout=30,
            )
            if r1.status_code == 200:
                conv_id = r1.json().get("conversation_id", "")
                msg_id  = r1.json().get("message_id", "")
                if conv_id and msg_id:
                    msg_url = f"{host}/api/2.0/genie/spaces/{SC_GENIE_SPACE_ID}/conversations/{conv_id}/messages/{msg_id}"
                    for _ in range(15):
                        time.sleep(3)
                        r2 = requests.get(msg_url, headers=hdrs, timeout=15)
                        if r2.status_code != 200:
                            break
                        payload = r2.json()
                        if payload.get("status") in ("COMPLETED", "FAILED", "CANCELLED"):
                            content = next((a["text"]["content"] for a in payload.get("attachments", []) if a.get("text")), "")
                            if content:
                                return jsonify({"answer": content, "sources": ["genie"], "follow_ups": []})
                            break
        except Exception as e:
            print(f"[SC Genie] exception: {e}", flush=True)
    fb = _pick_fallback(question)
    return jsonify({"answer": fb["answer"], "sources": ["supply_chain_delta_lake"],
                    "follow_ups": fb.get("follow_ups", []), "simulated": True})


@app.route("/supply-chain/api/actions")
@login_required
def sc_get_actions():
    return jsonify([{**{k: v for k, v in a.items() if k != "keywords"},
                     "status": _action_status.get(a["id"], a["status"])} for a in _ACTIONS])


@app.route("/supply-chain/api/actions/suggest", methods=["POST"])
@login_required
def sc_suggest_actions():
    data   = request.get_json(silent=True) or {}
    text   = (data.get("question", "") + " " + data.get("answer", "")).lower()
    scored = [(sum(1 for kw in a["keywords"] if kw in text), a)
              for a in _ACTIONS if _action_status.get(a["id"]) not in ("approved", "dismissed")]
    scored = sorted([(s, a) for s, a in scored if s], key=lambda x: (-x[0], -x[1]["impact_usd"]))
    return jsonify([{**{k: v for k, v in a.items() if k != "keywords"},
                     "status": _action_status.get(a["id"], a["status"])} for _, a in scored[:3]])


@app.route("/supply-chain/api/actions/execute", methods=["POST"])
@login_required
def sc_execute_action():
    data      = request.get_json(silent=True) or {}
    action_id = data.get("action_id", "")
    outcome   = data.get("outcome", "approved")
    if not action_id:
        return jsonify({"error": "action_id required"}), 400
    _action_status[action_id] = outcome
    user = request.headers.get("X-Forwarded-User") or session.get("username", "user")
    return jsonify({"action_id": action_id, "outcome": outcome, "executed_by": user})


@app.route("/supply-chain/api/log-page-time", methods=["POST"])
@login_required
def sc_log_page_time():
    data    = request.get_json(silent=True) or {}
    page    = str(data.get("page", ""))[:64]
    seconds = int(data.get("seconds_spent", 0))
    user    = session.get("username", "anonymous")
    company = session.get("company_name", "")
    _delta_log_write(
        f"INSERT INTO {LOG_CATALOG}.{LOG_SCHEMA}.page_time_log "
        "(username, company_name, page, seconds_spent, app_name, recorded_at) "
        "VALUES (%s, %s, %s, %s, %s, current_timestamp())",
        (user, company, page, seconds, "Supply Chain Intelligence"),
    )
    _sheets_log_write({"type": "page_view", "username": user, "company_name": company,
                       "page": page, "seconds_spent": seconds, "app_name": "Supply Chain Intelligence"})
    return jsonify({"status": "ok"})


# ══════════════════════════════════════════════════════════════════════════════
# MANUFACTURING — /manufacturing/
# ══════════════════════════════════════════════════════════════════════════════

MFG_GENIE_SPACE_ID      = os.getenv("MFG_GENIE_SPACE_ID", "")
MFG_LLM_ENDPOINT        = os.getenv("MFG_LLM_ENDPOINT", "databricks-meta-llama-3-3-70b-instruct")
MFG_SQL_WAREHOUSE_HTTP_PATH = os.getenv("MFG_SQL_WAREHOUSE_HTTP_PATH", "")
MFG_UC_CATALOG          = os.getenv("MFG_UC_CATALOG", "solution_studio_catalog")
MFG_UC_SCHEMA           = os.getenv("MFG_UC_SCHEMA", "mfg_vision")
MFG_UC_VOLUME           = os.getenv("MFG_UC_VOLUME", "inspection_images")
MFG_VISION_ENDPOINT     = os.getenv("MFG_VISION_ENDPOINT", "")
MFG_PDM_ENDPOINT        = os.getenv("MFG_PDM_ENDPOINT", "predictive-maintenance")
MFG_MANUALS_ENDPOINT    = os.getenv("MFG_MANUALS_ENDPOINT", "mfg-manuals-rag")


# ── Gold table helpers ─────────────────────────────────────────────────────────

def _mfg_query_gold(sql_text):
    """Execute SQL against Databricks SQL Warehouse. Returns list of dicts or None."""
    if not MFG_SQL_WAREHOUSE_HTTP_PATH:
        return None
    try:
        from databricks import sql as dbsql
        host  = os.environ["DATABRICKS_HOST"].replace("https://", "").rstrip("/")
        token = os.environ["DATABRICKS_TOKEN"]
        with dbsql.connect(
            server_hostname=host,
            http_path=MFG_SQL_WAREHOUSE_HTTP_PATH,
            access_token=token,
        ) as conn:
            with conn.cursor() as c:
                c.execute(sql_text)
                cols = [d[0] for d in c.description]
                return [dict(zip(cols, row)) for row in c.fetchall()]
    except Exception:
        return None


def _mfg_gold_machine_state():
    rows = _mfg_query_gold("SELECT * FROM demo_nah_catalog.mfg_gold.machine_state ORDER BY line, machine_id")
    if not rows:
        return None
    return [
        {
            "id":               r["machine_id"],
            "line":             r["line"],
            "line_name":        r["line_name"],
            "name":             r["name"],
            "product":          r["product"],
            "state":            r["state"] or "running",
            "oee":              float(r["oee_pct"] or 0),
            "temp":             float(r["temp_c"] or 0),
            "cycle_time_sec":   float(r["cycle_time_sec"] or 0),
            "units_this_shift": int(r["units_this_shift"] or 0),
            "target_units_hr":  int(r["target_units_hr"] or 0),
            "fault_code":       r.get("fault_code"),
            "fault_msg":        r.get("fault_msg"),
            "idle_reason":      r.get("idle_reason"),
            "maintenance_type": r.get("maintenance_type"),
            "description":      r.get("description", ""),
        }
        for r in rows
    ]


def _mfg_gold_alarms():
    rows = _mfg_query_gold("""
        SELECT alarm_id, machine_id, severity, code, message, category,
               triggered_min_ago, acknowledged, impact
        FROM demo_nah_catalog.mfg_gold.alarms_active
        ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
                 triggered_min_ago
    """)
    if not rows:
        return None
    return [
        {
            "id":                r["alarm_id"],
            "machine_id":        r["machine_id"],
            "severity":          r["severity"],
            "code":              r["code"],
            "message":           r["message"],
            "category":          r["category"],
            "triggered_min_ago": int(r["triggered_min_ago"] or 0),
            "acknowledged":      bool(r["acknowledged"]),
            "impact":            r.get("impact", ""),
        }
        for r in rows
    ]


def _mfg_gold_oee_trend():
    rows = _mfg_query_gold("""
        SELECT shift_label, plant_oee, line_a_oee, line_b_oee, line_c_oee
        FROM demo_nah_catalog.mfg_gold.oee_by_shift
        ORDER BY shift_date ASC, shift_period ASC LIMIT 14
    """)
    if not rows:
        return None
    return [{"shift": r["shift_label"], "plant": float(r["plant_oee"] or 0),
             "line_a": float(r["line_a_oee"] or 0), "line_b": float(r["line_b_oee"] or 0),
             "line_c": float(r["line_c_oee"] or 0)} for r in rows]


def _mfg_gold_downtime():
    pareto = _mfg_query_gold("SELECT reason, minutes, pct FROM demo_nah_catalog.mfg_gold.downtime_pareto ORDER BY minutes DESC")
    mtbf   = _mfg_query_gold("SELECT machine_id, mtbf_hrs, mttr_hrs, failures_ytd, flagged FROM demo_nah_catalog.mfg_gold.mtbf_by_machine ORDER BY failures_ytd DESC")
    if not pareto or not mtbf:
        return None, None
    pareto_out = [{"reason": r["reason"], "minutes": int(r["minutes"] or 0), "pct": float(r["pct"] or 0)} for r in pareto]
    mtbf_out   = [{"id": r["machine_id"], "mtbf_hrs": float(r["mtbf_hrs"] or 0),
                   "mttr_hrs": float(r["mttr_hrs"] or 0), "failures_ytd": int(r["failures_ytd"] or 0),
                   "flagged": bool(r["flagged"])} for r in mtbf]
    return pareto_out, mtbf_out


def _mfg_gold_quality():
    summary = _mfg_query_gold("SELECT * FROM demo_nah_catalog.mfg_gold.quality_summary LIMIT 1")
    defects = _mfg_query_gold("SELECT defect_type, line, count, pct FROM demo_nah_catalog.mfg_gold.defects_by_type ORDER BY count DESC")
    if not summary or not defects:
        return None, None
    s = summary[0]
    summary_out = {
        "total_inspected_shift": int(s.get("total_inspected_shift") or 0),
        "total_passed_shift":    int(s.get("total_passed_shift") or 0),
        "total_scrap_shift":     int(s.get("total_scrap_shift") or 0),
        "total_rework_shift":    int(s.get("total_rework_shift") or 0),
        "first_pass_yield":      float(s.get("first_pass_yield") or 0),
        "scrap_rate_pct":        float(s.get("scrap_rate_pct") or 0),
        "rework_rate_pct":       float(s.get("rework_rate_pct") or 0),
        "target_fpy":            99.0,
    }
    defects_out = [{"type": r["defect_type"], "count": int(r["count"] or 0),
                    "line": r["line"], "pct": float(r["pct"] or 0)} for r in defects]
    return summary_out, defects_out


# ── Live simulation helpers ────────────────────────────────────────────────────

def _mfg_sin_val(base, amp, period, seed=0):
    return round(base + amp * math.sin(2 * math.pi * (time.time() + seed) / period), 2)

def _mfg_shift_elapsed_minutes():
    hour_of_day  = (time.time() % 86400) / 3600
    elapsed      = (hour_of_day - 6.0) % 24
    return max(0, elapsed * 60)

def _mfg_units_produced(rate_per_hour, seed=0):
    elapsed_hrs = _mfg_shift_elapsed_minutes() / 60
    base  = int(rate_per_hour * elapsed_hrs)
    noise = int(5 * math.sin(time.time() * 0.07 + seed))
    return max(0, base + noise)

def _mfg_machine_live_state(machine_id, base_state):
    import hashlib as _hl2
    if base_state in ("fault", "maintenance"):
        return base_state
    h = int(_hl2.md5(machine_id.encode()).hexdigest()[:4], 16) % 100
    if h < 15:
        slot   = int(time.time() / 45)
        slot_h = int(_hl2.md5(f"{machine_id}-{slot}".encode()).hexdigest()[:4], 16) % 100
        if slot_h < 20:
            return "idle"
    return base_state

def _mfg_live_oee(base_oee, machine_id):
    import hashlib as _hl2
    seed = int(_hl2.md5(machine_id.encode()).hexdigest()[:4], 16)
    return round(min(99.9, max(0, _mfg_sin_val(base_oee, 1.8, 120, seed))), 1)

def _mfg_live_temp(base_temp, machine_id):
    import hashlib as _hl2
    seed = int(_hl2.md5((machine_id + "t").encode()).hexdigest()[:4], 16)
    return round(_mfg_sin_val(base_temp, 1.5, 90, seed), 1)

def _mfg_live_cycle(base_ct, machine_id):
    import hashlib as _hl2
    seed = int(_hl2.md5((machine_id + "c").encode()).hexdigest()[:4], 16)
    return round(max(0.5, _mfg_sin_val(base_ct, 0.3, 60, seed)), 2)


# ── Unity Catalog Vision helpers ───────────────────────────────────────────────

MFG_INSPECTION_IMAGES = [
    {"id": "insp_001", "filename": "insp_001.png", "part": "Door Outer — RH Front",  "line": "B", "ground_truth": "clean"},
    {"id": "insp_002", "filename": "insp_002.png", "part": "Hood Outer Panel",        "line": "B", "ground_truth": "clean"},
    {"id": "insp_003", "filename": "insp_003.png", "part": "Roof Panel",              "line": "B", "ground_truth": "defective",
     "defect": "E-Coat Adhesion Failure", "bbox": [140, 152, 184, 196], "severity": "HIGH",   "confidence_sim": 0.942},
    {"id": "insp_004", "filename": "insp_004.png", "part": "Quarter Panel — RH",      "line": "B", "ground_truth": "clean"},
    {"id": "insp_005", "filename": "insp_005.png", "part": "Fender — LH Front",       "line": "B", "ground_truth": "clean"},
    {"id": "insp_006", "filename": "insp_006.png", "part": "Door Outer — LH Front",   "line": "B", "ground_truth": "clean"},
    {"id": "insp_007", "filename": "insp_007.png", "part": "Trunk Lid Panel",         "line": "B", "ground_truth": "defective",
     "defect": "E-Coat Adhesion Failure", "bbox": [173, 88, 213, 128], "severity": "MEDIUM", "confidence_sim": 0.886},
    {"id": "insp_008", "filename": "insp_008.png", "part": "Door Outer — LH Rear",    "line": "B", "ground_truth": "clean"},
    {"id": "insp_009", "filename": "insp_009.png", "part": "Quarter Panel — LH",      "line": "B", "ground_truth": "clean"},
    {"id": "insp_010", "filename": "insp_010.png", "part": "Fender — RH Front",       "line": "B", "ground_truth": "clean"},
]

def _mfg_uc_image_url(filename):
    return f"/Volumes/{MFG_UC_CATALOG}/{MFG_UC_SCHEMA}/{MFG_UC_VOLUME}/{filename}"

def _mfg_fetch_image_bytes(filename):
    try:
        host  = os.environ["DATABRICKS_HOST"].rstrip("/")
        token = os.environ["DATABRICKS_TOKEN"]
        hdrs  = {"Authorization": f"Bearer {token}"}
        r = requests.get(
            f"{host}/api/2.0/fs/files/Volumes/{MFG_UC_CATALOG}/{MFG_UC_SCHEMA}/{MFG_UC_VOLUME}/{filename}",
            headers=hdrs, timeout=15,
        )
        if r.status_code == 200:
            return r.content
    except Exception:
        pass
    # Local fallback (path updated for consolidated static layout)
    local = os.path.join(str(STATIC_DIR), "manufacturing", "img", "inspection", filename)
    if os.path.exists(local):
        with open(local, "rb") as f:
            return f.read()
    return None

def _mfg_extract_features(image_bytes):
    try:
        import io as _io
        from PIL import Image as _PILImage
        import numpy as _np
        IMG_SIZE = 64
        img  = _PILImage.open(_io.BytesIO(image_bytes)).convert("RGB")
        img  = img.resize((IMG_SIZE, IMG_SIZE), _PILImage.LANCZOS)
        arr  = _np.array(img).astype(_np.float32) / 255.0
        feats = []
        for c in range(3):
            ch = arr[:, :, c]; feats += [float(ch.mean()), float(ch.std())]
        for c in range(3):
            hist, _ = _np.histogram(arr[:, :, c], bins=16, range=(0.0, 1.0))
            feats  += (hist.astype(_np.float32) / hist.sum()).tolist()
        feats.append(float((arr < 0.28).all(axis=2).mean()))
        dark = float((arr < 0.28).all(axis=2).sum()); bright = float((arr > 0.72).all(axis=2).sum())
        feats.append(dark / max(1.0, bright + 1e-6))
        gray = arr.mean(axis=2); gy, gx = _np.gradient(gray); grad = _np.sqrt(gx**2 + gy**2)
        feats += [float(grad.mean()), float(grad.std())]
        mid = IMG_SIZE // 2
        for r0, r1 in [(0, mid), (mid, IMG_SIZE)]:
            for c0, c1 in [(0, mid), (mid, IMG_SIZE)]:
                region = arr[r0:r1, c0:c1]
                for ch in range(3): feats.append(float(region[:, :, ch].mean()))
        pad = int(IMG_SIZE * 0.15); centre = arr[pad:-pad, pad:-pad]
        edge = _np.concatenate([arr[:pad, :].reshape(-1, 3), arr[-pad:, :].reshape(-1, 3),
                                 arr[:, :pad, :].reshape(-1, 3), arr[:, -pad:, :].reshape(-1, 3)])
        feats += [float(centre.var()), float(edge.var()), float(arr.min()), float(arr.max())]
        for c in range(3):
            ch = arr[:, :, c]; mu, sigma = ch.mean(), ch.std() + 1e-6
            feats.append(float(((ch - mu) ** 3).mean() / sigma ** 3))
        return feats
    except Exception:
        return None

def _mfg_call_vision_endpoint(image_bytes, image_id, spec):
    feats = _mfg_extract_features(image_bytes)
    if feats is None:
        return None
    try:
        host  = os.environ["DATABRICKS_HOST"].rstrip("/")
        token = os.environ["DATABRICKS_TOKEN"]
        hdrs  = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        payload = {"dataframe_records": [{f"x{i}": v for i, v in enumerate(feats)}]}
        r = requests.post(f"{host}/serving-endpoints/{MFG_VISION_ENDPOINT}/invocations",
                          headers=hdrs, json=payload, timeout=20)
        if r.status_code == 200:
            preds = r.json().get("predictions", [])
            if preds:
                pred_val = preds[0]
                if str(pred_val) in ("1", "defective"):
                    return {"prediction": "defective", "defect_type": spec.get("defect", "E-Coat Adhesion Failure"),
                            "confidence": 0.92, "severity": spec.get("severity", "HIGH"),
                            "bbox": spec.get("bbox"), "source": "model"}
                else:
                    return {"prediction": "clean", "defect_type": None,
                            "confidence": 0.96, "severity": None, "bbox": None, "source": "model"}
    except Exception:
        pass
    return None

def _mfg_simulate_inspect(spec):
    if spec["ground_truth"] == "clean":
        confidence = round(0.940 + (abs(hash(spec["id"])) % 58) / 1000.0, 3)
        return {"prediction": "clean", "defect_type": None, "confidence": confidence,
                "severity": None, "bbox": None}
    return {"prediction": "defective", "defect_type": spec["defect"],
            "confidence": spec["confidence_sim"], "severity": spec["severity"], "bbox": spec["bbox"]}


# ── Static machine & alarm definitions ────────────────────────────────────────

MFG_MACHINES_STATIC = [
    # Line A: Body Shop
    {"id": "BDY-STM-01", "line": "A", "line_name": "Body Shop", "name": "3,000-Ton Stamping Press", "product": "VBA",
     "base_state": "running", "base_oee": 56.4, "base_temp": 48.4, "std_cycle_sec": 6.0, "target_units_hr": 580,
     "description": "Progressive die stamping — hood, doors, roof, fenders, quarter panels",
     "sensor_tags": ["tonnage", "die_temp_c", "feed_rate_spm"]},
    {"id": "BDY-WLD-01", "line": "A", "line_name": "Body Shop", "name": "Robotic Welding Cell", "product": "VBA",
     "base_state": "fault", "base_oee": 0, "base_temp": 52.1, "std_cycle_sec": 90.0, "target_units_hr": 38,
     "fault_code": "E-1106",
     "fault_msg": "Electrode tip failure — weld current compensation exceeded 100% on robots 3, 7, 14. BIW weld quality out of spec.",
     "description": "24-robot body-in-white (BIW) cell — 3,500+ spot welds per body shell",
     "sensor_tags": ["weld_current_ka", "electrode_force_kn", "cycle_time_s"]},
    {"id": "BDY-SLD-01", "line": "A", "line_name": "Body Shop", "name": "Sealing & Hemming Station", "product": "VBA",
     "base_state": "fault", "base_oee": 0, "base_temp": 28.3, "std_cycle_sec": 45.0, "target_units_hr": 78,
     "fault_code": "E-3301",
     "fault_msg": "Hemming die misalignment — door flange gap 1.8mm vs. 0.5mm tolerance. 44 bodies queued.",
     "description": "Robotic seam sealing and door/hood/trunk hemming",
     "sensor_tags": ["sealant_flow_ml", "hem_force_kn", "gap_flush_mm"]},
    {"id": "BDY-INS-01", "line": "A", "line_name": "Body Shop", "name": "CMM Body Dimension Check", "product": "VBA",
     "base_state": "idle", "base_oee": 0, "base_temp": 22.1, "std_cycle_sec": 30.0, "target_units_hr": 118,
     "idle_reason": "WIP queue full — FAL-ASM-01 fault blocking all body throughput, 61 bodies accumulated upstream",
     "description": "Coordinate measurement machine — gap/flush and dimensional compliance audit",
     "sensor_tags": ["gap_mm", "flush_mm", "cpk_score"]},
    # Line B: Paint Shop
    {"id": "PNT-PRP-01", "line": "B", "line_name": "Paint Shop", "name": "Phosphate Pre-Treatment", "product": "PBU",
     "base_state": "running", "base_oee": 58.9, "base_temp": 54.8, "std_cycle_sec": 120.0, "target_units_hr": 28,
     "description": "Multi-stage zinc phosphate wash and conversion coating for corrosion protection",
     "sensor_tags": ["bath_temp_c", "ph_level", "coating_weight_g_m2"]},
    {"id": "PNT-ECT-01", "line": "B", "line_name": "Paint Shop", "name": "E-Coat Tank (CED)", "product": "PBU",
     "base_state": "fault", "base_oee": 0, "base_temp": 30.2, "std_cycle_sec": 180.0, "target_units_hr": 18,
     "fault_code": "E-4401",
     "fault_msg": "Bath contamination — iron particulate 340 ppm vs. 50 ppm limit. 18-body carrier lot quarantined, tank draining.",
     "description": "Cathodic electro-deposition primer — full-cavity corrosion protection",
     "sensor_tags": ["voltage_v", "bath_temp_c", "film_thickness_um"]},
    {"id": "PNT-BSC-01", "line": "B", "line_name": "Paint Shop", "name": "Robotic Base Coat Booth", "product": "PBU",
     "base_state": "idle", "base_oee": 0, "base_temp": 25.4, "std_cycle_sec": 60.0, "target_units_hr": 58,
     "idle_reason": "Starved — PNT-ECT-01 bath contamination fault has halted all painted body units entering booth",
     "description": "12-robot waterborne base coat — color and metallic effect layers",
     "sensor_tags": ["film_build_um", "spray_pressure_bar", "transfer_efficiency_pct"]},
    {"id": "PNT-CLR-01", "line": "B", "line_name": "Paint Shop", "name": "Clear Coat & Bake Oven", "product": "PBU",
     "base_state": "idle", "base_oee": 0, "base_temp": 141.0, "std_cycle_sec": 1800.0, "target_units_hr": 2,
     "idle_reason": "No bodies in queue — Paint Shop offline due to E-Coat contamination fault upstream",
     "description": "High-solids clear coat application and 140°C bake oven cure cycle",
     "sensor_tags": ["oven_temp_c", "cure_time_min", "gloss_gu"]},
    {"id": "PNT-INS-01", "line": "B", "line_name": "Paint Shop", "name": "Paint Quality Inspection", "product": "PBU",
     "base_state": "maintenance", "base_oee": 0, "base_temp": 23.5, "std_cycle_sec": 20.0, "target_units_hr": 172,
     "maintenance_type": "Scheduled PM — wavescan vision calibration and LED lighting replacement (coinciding with E-Coat shutdown)",
     "description": "Automated paint defect detection: orange peel, runs, sags, contamination, mottling",
     "sensor_tags": ["defect_count", "wavescan_du", "doi_score"]},
    # Line C: Powertrain
    {"id": "PTN-MCH-01", "line": "C", "line_name": "Powertrain", "name": "CNC Block Machining Center", "product": "PTM",
     "base_state": "running", "base_oee": 63.2, "base_temp": 42.3, "std_cycle_sec": 120.0, "target_units_hr": 28,
     "description": "5-axis CNC machining — cylinder boring, honing, deck facing, lifter bore",
     "sensor_tags": ["spindle_load_pct", "coolant_temp_c", "tool_wear_pct"]},
    {"id": "PTN-HAD-01", "line": "C", "line_name": "Powertrain", "name": "Cylinder Head Assembly", "product": "PTM",
     "base_state": "running", "base_oee": 52.8, "base_temp": 31.7, "std_cycle_sec": 96.0, "target_units_hr": 36,
     "description": "Automated valve train assembly, cam bearing install, torque-to-yield fastening",
     "sensor_tags": ["torque_nm", "torque_angle_deg", "valve_clearance_mm"]},
    {"id": "PTN-BLD-01", "line": "C", "line_name": "Powertrain", "name": "Engine Build Station", "product": "PTM",
     "base_state": "fault", "base_oee": 0, "base_temp": 36.8, "std_cycle_sec": 240.0, "target_units_hr": 14,
     "fault_code": "E-5502",
     "fault_msg": "Torque angle fault — crankshaft main bearing cap torque not met. 18 engine builds halted.",
     "description": "Final engine assembly: block+head marriage, crankshaft, piston/ring install",
     "sensor_tags": ["torque_nm", "angle_deg", "crank_endplay_mm"]},
    {"id": "PTN-DYN-01", "line": "C", "line_name": "Powertrain", "name": "Cold Test Dyno Cell", "product": "PTM",
     "base_state": "running", "base_oee": 41.6, "base_temp": 58.4, "std_cycle_sec": 300.0, "target_units_hr": 11,
     "description": "Cold-test dynamometer — crankshaft rotation, compression, leak-down test",
     "sensor_tags": ["cold_crank_nm", "compression_bar", "leak_rate_cc_min"]},
    # Shared: Final Assembly
    {"id": "FAL-ASM-01", "line": "S", "line_name": "Final Assembly", "name": "Final Assembly Line", "product": "VEH",
     "base_state": "fault", "base_oee": 0, "base_temp": 26.4, "std_cycle_sec": 60.0, "target_units_hr": 60,
     "fault_code": "E-7701",
     "fault_msg": "Conveyor sequencer fault — PLC watchdog timeout on transfer car #4. Line stopped 52 min. ALL upstream lines blocked.",
     "description": "Body+powertrain+paint marriage, trim install, glass, fluids, end-of-line QC gate",
     "sensor_tags": ["takt_time_s", "torque_completion_pct", "quality_gate_pass_rate"]},
]

MFG_ALARMS_STATIC = [
    {"id": "ALM-001", "machine_id": "FAL-ASM-01", "severity": "CRITICAL", "code": "E-7701",
     "message": "Conveyor sequencer fault — transfer car #4 PLC watchdog timeout. Final assembly line STOPPED for 52 min.",
     "category": "Equipment Fault", "triggered_min_ago": 52, "acknowledged": False,
     "impact": "ALL 3 LINES BLOCKED — VBA/PBU/PTM feed halted. 34 vehicles at risk. 60 vehicles/hr output at zero.",
     "ai_root_cause": "Conveyor PLC sequencer watchdog timeout caused by intermittent encoder signal loss on transfer car #4. Replace encoder assembly (Part #TC4-ENC-200), reset PLC sequence, and verify handshake with upstream accumulation conveyor."},
    {"id": "ALM-002", "machine_id": "PNT-ECT-01", "severity": "CRITICAL", "code": "E-4401",
     "message": "E-Coat bath contamination — iron particulate 340 ppm vs. 50 ppm limit. 18-body carrier lot quarantined.",
     "category": "Quality Hold", "triggered_min_ago": 88, "acknowledged": False,
     "impact": "Paint Shop offline — 18 bodies quarantined for strip/re-coat. PBU throughput at zero for remainder of shift.",
     "ai_root_cause": "Phosphate pre-treatment rinse stage failure — iron dragout not neutralized before E-Coat immersion. Drain and replace bath (~4 hrs), acid-wash tank interior, re-qualify with test panel before resuming production."},
    {"id": "ALM-003", "machine_id": "BDY-WLD-01", "severity": "CRITICAL", "code": "E-1106",
     "message": "Electrode tip failure — weld current compensation exceeded 100% limit on robots 3, 7, 14. BIW weld porosity confirmed.",
     "category": "Equipment Fault", "triggered_min_ago": 19, "acknowledged": False,
     "impact": "Robotic weld cell STOPPED — 26 bodies in queue, Body Shop at zero VBA output. All bodies since 08:40 on quality hold.",
     "ai_root_cause": "Electrode tip worn beyond compensation range — accelerated from high-strength steel alloy change 3 shifts ago. Immediate tip replacement on robots 3, 7, 14. Reduce dress interval from 800 to 500 welds going forward."},
    {"id": "ALM-004", "machine_id": "BDY-SLD-01", "severity": "CRITICAL", "code": "E-3301",
     "message": "Hemming die misalignment — door flange gap 1.8mm vs. 0.5mm tolerance. 44 bodies queued.",
     "category": "Equipment Fault", "triggered_min_ago": 134, "acknowledged": False,
     "impact": "Sealing station halted for 2h 14m — 44 VBA in queue, ongoing 78 bodies/hr capacity loss",
     "ai_root_cause": "Hemming die cam follower wear on door station 2. Replace cam follower assembly (Part #HD-CFW-44), re-shim die, and re-qualify gap/flush to within 0.3mm before restart."},
    {"id": "ALM-005", "machine_id": "PTN-BLD-01", "severity": "CRITICAL", "code": "E-5502",
     "message": "Crankshaft main bearing cap torque angle 63° vs. 78° target — torque fault. 18 engine builds halted.",
     "category": "Equipment Fault", "triggered_min_ago": 67, "acknowledged": False,
     "impact": "Engine build stopped — 18 PTM units halted, powertrain feed dropping. Cold test failure rate now 43% on completed engines.",
     "ai_root_cause": "Torque wrench transducer calibration drift on assembly spindle #3. Recalibrate against master torque standard. All engines built after 07:20 require torque re-verification before dyno test."},
    {"id": "ALM-006", "machine_id": "PTN-DYN-01", "severity": "HIGH", "code": "W-6601",
     "message": "Cold test failure rate 43% this shift — cylinder 3 compression below spec on multiple engines.",
     "category": "Quality Risk", "triggered_min_ago": 41, "acknowledged": True,
     "impact": "43% of completed engines failing dyno — 3.2 hr rework loop per engine consuming all available dyno time",
     "ai_root_cause": "Head gasket seating failures traced to undertorqued main bearing caps from PTN-BLD-01 fault. All engines built after 07:20 to be re-inspected per quality hold QH-2024-047."},
    {"id": "ALM-007", "machine_id": "PTN-MCH-01", "severity": "MEDIUM", "code": "W-3302",
     "message": "Tool wear at 94% of replacement threshold — spindle #4 bore diameter trending to lower control limit.",
     "category": "Maintenance Due", "triggered_min_ago": 95, "acknowledged": True,
     "impact": "SPC chart out of control — bore diameter Cpk 0.84, below 1.33 target. Quality risk in next 40 parts.",
     "ai_root_cause": "Accelerated wear from coolant concentration drop to 6% (target 8-9%). Correct coolant concentration immediately and replace spindle #4 insert before next 40 parts."},
]


def _mfg_build_live_machines():
    import hashlib as _hl2
    machines = []
    for m in MFG_MACHINES_STATIC:
        live_state = _mfg_machine_live_state(m["id"], m["base_state"])
        is_running = live_state == "running"
        seed  = int(_hl2.md5(m["id"].encode()).hexdigest()[:4], 16)
        units = _mfg_units_produced(m["target_units_hr"], seed) if is_running else 0
        oee   = _mfg_live_oee(m["base_oee"], m["id"]) if is_running else 0
        temp  = _mfg_live_temp(m["base_temp"], m["id"])
        cycle = _mfg_live_cycle(m["std_cycle_sec"], m["id"]) if is_running else m["std_cycle_sec"]
        machines.append({
            "id": m["id"], "line": m["line"], "line_name": m["line_name"],
            "name": m["name"], "product": m["product"], "state": live_state,
            "oee": oee, "temp": temp, "cycle_time_sec": cycle,
            "units_this_shift": units, "target_units_hr": m["target_units_hr"],
            "fault_code": m.get("fault_code"), "fault_msg": m.get("fault_msg"),
            "idle_reason": m.get("idle_reason"), "maintenance_type": m.get("maintenance_type"),
            "description": m["description"],
        })
    return machines


def _mfg_compute_plant_kpi(machines):
    running = [m for m in machines if m["state"] == "running"]
    faults  = [m for m in machines if m["state"] == "fault"]
    idle    = [m for m in machines if m["state"] == "idle"]
    maint   = [m for m in machines if m["state"] == "maintenance"]
    oee_running = [m["oee"] for m in running if m["oee"] > 0]
    plant_oee   = round(sum(oee_running) / len(oee_running), 1) if oee_running else 0
    vba = [m for m in machines if m["product"] == "VBA"]
    pbu = [m for m in machines if m["product"] == "PBU"]
    ptm = [m for m in machines if m["product"] == "PTM"]
    return {
        "total_machines":   len(machines),
        "running":          len(running),
        "fault":            len(faults),
        "idle":             len(idle),
        "maintenance":      len(maint),
        "plant_oee":        plant_oee,
        "oee_target":       85.0,
        "total_alarms":     len(MFG_ALARMS_STATIC),
        "critical_alarms":  sum(1 for a in MFG_ALARMS_STATIC if a["severity"] == "CRITICAL"),
        "unacknowledged":   sum(1 for a in MFG_ALARMS_STATIC if not a["acknowledged"]),
        "vba_shift_units":  sum(m["units_this_shift"] for m in vba if m["state"] == "running"),
        "vba_target_shift": 420,
        "pbu_shift_units":  sum(m["units_this_shift"] for m in pbu if m["state"] == "running"),
        "pbu_target_shift": 180,
        "ptm_shift_units":  sum(m["units_this_shift"] for m in ptm if m["state"] == "running"),
        "ptm_target_shift": 240,
        "shift_elapsed_min": round(_mfg_shift_elapsed_minutes(), 0),
    }


MFG_OEE_TREND = [
    {"shift": "Mon D", "plant": 78.2, "line_a": 81.4, "line_b": 76.8, "line_c": 79.1},
    {"shift": "Mon N", "plant": 75.4, "line_a": 78.2, "line_b": 73.1, "line_c": 75.3},
    {"shift": "Tue D", "plant": 71.8, "line_a": 74.6, "line_b": 70.2, "line_c": 72.5},
    {"shift": "Tue N", "plant": 68.3, "line_a": 72.1, "line_b": 65.4, "line_c": 68.9},
    {"shift": "Wed D", "plant": 63.4, "line_a": 68.8, "line_b": 59.7, "line_c": 65.1},
    {"shift": "Wed N", "plant": 57.2, "line_a": 63.4, "line_b": 52.1, "line_c": 58.8},
    {"shift": "Thu D", "plant": 46.4, "line_a": 54.2, "line_b": 38.6, "line_c": 48.7},
]

MFG_DOWNTIME_PARETO = [
    {"reason": "Final Assembly Conveyor Fault",  "minutes": 312, "pct": 38.2},
    {"reason": "Equipment Fault (BDY / PTN)",    "minutes": 241, "pct": 29.5},
    {"reason": "E-Coat Bath Contamination Hold", "minutes": 148, "pct": 18.1},
    {"reason": "Quality Rework / Retest Loop",   "minutes": 82,  "pct": 10.0},
    {"reason": "Planned Maintenance",            "minutes": 34,  "pct": 4.2},
]

MFG_MACHINE_MTBF = [
    {"id": "FAL-ASM-01", "mtbf_hrs": 48,  "mttr_hrs": 4.2, "failures_ytd": 38, "flagged": True},
    {"id": "BDY-SLD-01", "mtbf_hrs": 52,  "mttr_hrs": 3.8, "failures_ytd": 32, "flagged": True},
    {"id": "PNT-ECT-01", "mtbf_hrs": 61,  "mttr_hrs": 5.1, "failures_ytd": 27, "flagged": True},
    {"id": "PTN-BLD-01", "mtbf_hrs": 78,  "mttr_hrs": 2.8, "failures_ytd": 26, "flagged": True},
    {"id": "BDY-WLD-01", "mtbf_hrs": 98,  "mttr_hrs": 1.6, "failures_ytd": 22, "flagged": True},
    {"id": "PTN-DYN-01", "mtbf_hrs": 184, "mttr_hrs": 1.2, "failures_ytd": 14},
    {"id": "PTN-MCH-01", "mtbf_hrs": 228, "mttr_hrs": 2.1, "failures_ytd": 9},
    {"id": "BDY-STM-01", "mtbf_hrs": 312, "mttr_hrs": 1.6, "failures_ytd": 4},
]

MFG_QUALITY_SUMMARY = {
    "total_inspected_shift": 2840, "total_passed_shift": 2186,
    "total_scrap_shift": 224, "total_rework_shift": 430,
    "first_pass_yield": 76.9, "scrap_rate_pct": 7.9,
    "rework_rate_pct": 15.1, "target_fpy": 98.5,
}

MFG_DEFECT_TYPES = [
    {"type": "E-Coat Adhesion Failure",  "count": 187, "line": "B", "pct": 38.2},
    {"type": "Weld Porosity / Spatter",  "count": 124, "line": "A", "pct": 25.4},
    {"type": "Torque Non-Conformance",   "count": 88,  "line": "C", "pct": 18.0},
    {"type": "Hemming Dimensional",      "count": 52,  "line": "A", "pct": 10.6},
    {"type": "Paint Surface Contam.",    "count": 28,  "line": "B", "pct": 5.7},
    {"type": "Other",                    "count": 10,  "line": "C", "pct": 2.0},
]


def _mfg_generate_ai_recommendation(machine_id: str) -> str:
    machine = next((m for m in MFG_MACHINES_STATIC if m["id"] == machine_id), None)
    alarms  = [a for a in MFG_ALARMS_STATIC if a["machine_id"] == machine_id]
    if not machine:
        return "Machine not found."
    try:
        host  = os.environ["DATABRICKS_HOST"].rstrip("/")
        token = os.environ["DATABRICKS_TOKEN"]
        hdrs  = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        alarm_text = "\n".join(f"- [{a['severity']}] {a['message']}" for a in alarms) or "No active alarms."
        prompt = (
            f"You are the Databricks Manufacturing Intelligence AI — an expert in automotive manufacturing operations.\n\n"
            f"MACHINE: {machine['id']} — {machine['name']}\nLINE: {machine['line_name']}\n"
            f"PRODUCT: {machine['product']}\nCURRENT STATE: {machine['base_state'].upper()}\n"
            f"DESCRIPTION: {machine['description']}\nSENSOR TAGS: {', '.join(machine['sensor_tags'])}\n\n"
            f"ACTIVE ALARMS:\n{alarm_text}\n\n"
            f"Generate your analysis in EXACTLY this format:\n"
            f"**ROOT CAUSE:** [1-2 sentences.]\n**CONFIDENCE:** [X%]\n"
            f"**IMMEDIATE ACTIONS (Next 30 Minutes):**\n- [Action 1]\n- [Action 2]\n- [Action 3]\n"
            f"**PARTS REQUIRED:** [Specific parts]\n**EST. REPAIR TIME:** [X hours]\n"
            f"**PRODUCTION RECOVERY PLAN:** [How to recover]\n**PREVENTIVE ACTION:** [Long-term fix]\n\n"
            f"Use manufacturing engineering precision."
        )
        r = requests.post(
            f"{host}/serving-endpoints/{MFG_LLM_ENDPOINT}/invocations",
            headers=hdrs,
            json={"messages": [{"role": "user", "content": prompt}], "max_tokens": 500, "temperature": 0.2},
            timeout=50,
        )
        if r.status_code == 200:
            return r.json().get("choices", [{}])[0].get("message", {}).get("content", "")
    except Exception:
        pass
    alarm = alarms[0] if alarms else {}
    return (
        f"**ROOT CAUSE:** {alarm.get('ai_root_cause', 'Component degradation detected via sensor pattern analysis. Maintenance inspection required.')}\n\n"
        f"**CONFIDENCE:** 87%\n\n"
        f"**IMMEDIATE ACTIONS (Next 30 Minutes):**\n"
        f"- Isolate machine and place LOTO (Lockout/Tagout) — Technician\n"
        f"- Pull fault diagnostics from machine controller — Process Engineer\n"
        f"- Place quality hold on units produced 30 min prior to fault — Quality Engineer\n\n"
        f"**PARTS REQUIRED:** Refer to machine BOM in Maintenance module\n\n"
        f"**EST. REPAIR TIME:** 2–4 hours\n\n"
        f"**PRODUCTION RECOVERY PLAN:** Reroute affected WIP to redundant station if available.\n\n"
        f"**PREVENTIVE ACTION:** Increase PM frequency based on MTBF trend."
    )


_MFG_POLL_INTERVAL = 3
_MFG_MAX_WAIT      = 120


def _mfg_poll_genie(host, hdrs, space_id, conversation_id, message_id):
    deadline = time.time() + _MFG_MAX_WAIT
    while time.time() < deadline:
        r = requests.get(
            f"{host}/api/2.0/genie/spaces/{space_id}/conversations/{conversation_id}/messages/{message_id}",
            headers=hdrs, timeout=30,
        )
        if r.status_code == 200:
            msg = r.json()
            if msg.get("status") in ("COMPLETED", "FAILED", "CANCELLED"):
                return msg
        time.sleep(_MFG_POLL_INTERVAL)
    return None


def _mfg_extract_answer(msg):
    if not msg:
        return "No response received."
    for att in msg.get("attachments", []):
        content = (att.get("text") or {}).get("content") or att.get("content")
        if content:
            return content
    return msg.get("content", "No answer returned.")


# ── Manufacturing routes ───────────────────────────────────────────────────────

@app.route("/manufacturing/")
@login_required
def mfg_index():
    return send_from_directory(str(STATIC_DIR / "manufacturing"), "index.html")


@app.route("/manufacturing/api/live")
@login_required
def mfg_live():
    gold = _mfg_gold_machine_state()
    if gold:
        kpi = _mfg_compute_plant_kpi(gold)
        return jsonify({"machines": gold, "kpi": kpi, "ts": int(time.time()), "source": "gold"})
    machines = _mfg_build_live_machines()
    kpi      = _mfg_compute_plant_kpi(machines)
    return jsonify({"machines": machines, "kpi": kpi, "ts": int(time.time()), "source": "sim"})


@app.route("/manufacturing/api/alarms")
@login_required
def mfg_alarms():
    gold = _mfg_gold_alarms()
    if gold is not None:
        return jsonify(gold)
    return jsonify(MFG_ALARMS_STATIC)


@app.route("/manufacturing/api/downtime")
@login_required
def mfg_downtime():
    pareto, mtbf = _mfg_gold_downtime()
    if pareto and mtbf:
        return jsonify({"pareto": pareto, "mtbf": mtbf})
    return jsonify({"pareto": MFG_DOWNTIME_PARETO, "mtbf": MFG_MACHINE_MTBF})


@app.route("/manufacturing/api/oee-trend")
@login_required
def mfg_oee_trend():
    gold = _mfg_gold_oee_trend()
    if gold:
        return jsonify(gold)
    return jsonify(MFG_OEE_TREND)


@app.route("/manufacturing/api/quality")
@login_required
def mfg_quality():
    summary, defects = _mfg_gold_quality()
    if summary and defects:
        return jsonify({"summary": summary, "defects": defects})
    return jsonify({"summary": MFG_QUALITY_SUMMARY, "defects": MFG_DEFECT_TYPES})


@app.route("/manufacturing/api/diagnose/<machine_id>")
@login_required
def mfg_diagnose(machine_id):
    rec = _mfg_generate_ai_recommendation(machine_id)
    return jsonify({"machine_id": machine_id, "recommendation": rec})


@app.route("/manufacturing/api/ask", methods=["POST"])
@login_required
def mfg_ask():
    data            = request.get_json(force=True) or {}
    question        = data.get("question", "").strip()
    conversation_id = data.get("conversation_id") or None
    if not question:
        return jsonify({"error": "No question provided"}), 400

    machines = _mfg_build_live_machines()
    kpi      = _mfg_compute_plant_kpi(machines)

    if not MFG_GENIE_SPACE_ID:
        try:
            host  = os.environ["DATABRICKS_HOST"].rstrip("/")
            token = os.environ["DATABRICKS_TOKEN"]
            hdrs  = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            context = (
                f"You are SHIFT, the Databricks Manufacturing Intelligence AI. "
                f"Plant OEE: {kpi['plant_oee']}% (target {kpi['oee_target']}%). "
                f"Machines: {kpi['running']} running / {kpi['fault']} fault / {kpi['idle']} idle. "
                f"Critical alarms: {kpi['critical_alarms']}. "
                f"Shift output — VBA: {kpi['vba_shift_units']}/{kpi['vba_target_shift']}, "
                f"PBU: {kpi['pbu_shift_units']}/{kpi['pbu_target_shift']}, "
                f"PTM: {kpi['ptm_shift_units']}/{kpi['ptm_target_shift']}.\n"
                f"Active CRITICAL faults:\n"
            )
            for a in MFG_ALARMS_STATIC:
                if a["severity"] == "CRITICAL":
                    context += f"- {a['machine_id']}: {a['message']} | {a['ai_root_cause']}\n"
            context += f"\nAnswer with manufacturing precision: {question}"
            r = requests.post(
                f"{host}/serving-endpoints/{MFG_LLM_ENDPOINT}/invocations",
                headers=hdrs,
                json={"messages": [{"role": "user", "content": context}], "max_tokens": 500, "temperature": 0.3},
                timeout=50,
            )
            if r.status_code == 200:
                answer = r.json().get("choices", [{}])[0].get("message", {}).get("content", "")
                return jsonify({"answer": answer, "conversation_id": None, "source": "LLM",
                                "follow_ups": ["Which machine has the worst MTBF?",
                                               "What is the projected shift output if faults resolve in 2 hours?",
                                               "Which defect type is causing the most scrap on Line B?"]})
        except Exception:
            pass
        return jsonify({
            "answer": (
                f"**SHIFT Intelligence — Plant Status**\n\n"
                f"**Plant OEE:** {kpi['plant_oee']}% vs. {kpi['oee_target']}% target ⚠ CRITICAL\n\n"
                f"**Machine Status:** {kpi['running']} running | {kpi['fault']} fault | "
                f"{kpi['idle']} idle | {kpi['maintenance']} maintenance\n\n"
                f"**Root Cause:** FAL-ASM-01 conveyor fault (52 min) has cascaded — ALL 3 lines blocked.\n\n"
                f"**Shift Output:** VBA {kpi['vba_shift_units']}/{kpi['vba_target_shift']} | "
                f"PBU {kpi['pbu_shift_units']}/{kpi['pbu_target_shift']} | "
                f"PTM {kpi['ptm_shift_units']}/{kpi['ptm_target_shift']}\n\n"
                f"**Quality:** FPY 76.9% vs. 98.5% target — 224 scrapped, 430 rework units this shift.\n\n"
                f"Set `MFG_GENIE_SPACE_ID` in app.yaml for live Delta Lake queries."
            ),
            "conversation_id": None, "source": "demo",
            "follow_ups": ["What is the total vehicle output loss from the FAL-ASM-01 fault?",
                           "Which fault should be resolved first to recover the most throughput?",
                           "Why is the cold test dyno failure rate at 43%?"],
        })

    try:
        host  = os.environ["DATABRICKS_HOST"].rstrip("/")
        token = os.environ["DATABRICKS_TOKEN"]
        hdrs  = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    except KeyError as e:
        return jsonify({"error": f"Missing env var: {e}"}), 500

    try:
        prefix = (
            "You are the SHIFT manufacturing intelligence assistant at an automotive plant. "
            "3 lines: Body Shop (VBA), Paint Shop (PBU), Powertrain (PTM), converging at Final Assembly (FAL-ASM-01). "
            "Use precise automotive manufacturing terminology. "
        )
        full_q = prefix + question
        if conversation_id:
            r = requests.post(
                f"{host}/api/2.0/genie/spaces/{MFG_GENIE_SPACE_ID}/conversations/{conversation_id}/messages",
                headers=hdrs, json={"content": full_q}, timeout=30,
            )
        else:
            r = requests.post(
                f"{host}/api/2.0/genie/spaces/{MFG_GENIE_SPACE_ID}/start-conversation",
                headers=hdrs, json={"content": full_q}, timeout=30,
            )
        if r.status_code not in (200, 201):
            return jsonify({"error": f"Genie error {r.status_code}"}), 502
        resp_json       = r.json()
        conversation_id = resp_json.get("conversation_id") or conversation_id
        message_id      = resp_json.get("message_id") or resp_json.get("id")
        msg             = _mfg_poll_genie(host, hdrs, MFG_GENIE_SPACE_ID, conversation_id, message_id)
        return jsonify({"answer": _mfg_extract_answer(msg), "conversation_id": conversation_id,
                        "source": "genie",
                        "follow_ups": ["Which machine has the worst MTBF?",
                                       "What is the shift OEE trend for Line A?",
                                       "Show me the top 3 defect types this week."]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/manufacturing/api/inspection/images")
@login_required
def mfg_inspection_images():
    return jsonify([
        {"id": img["id"], "filename": img["filename"], "part": img["part"],
         "uc_path": _mfg_uc_image_url(img["filename"])}
        for img in MFG_INSPECTION_IMAGES
    ])


@app.route("/manufacturing/api/inspection/image/<image_id>")
@login_required
def mfg_inspection_image(image_id):
    from flask import Response
    spec = next((img for img in MFG_INSPECTION_IMAGES if img["id"] == image_id), None)
    if not spec:
        return jsonify({"error": "Unknown image ID"}), 404
    data = _mfg_fetch_image_bytes(spec["filename"])
    if data:
        return Response(data, mimetype="image/png", headers={"Cache-Control": "public, max-age=3600"})
    return jsonify({"error": "Image not found"}), 404


@app.route("/manufacturing/api/inspect/<image_id>")
@login_required
def mfg_inspect(image_id):
    spec = next((img for img in MFG_INSPECTION_IMAGES if img["id"] == image_id), None)
    if not spec:
        return jsonify({"error": "Unknown image ID"}), 404
    result = None
    if MFG_VISION_ENDPOINT:
        image_bytes = _mfg_fetch_image_bytes(spec["filename"])
        if image_bytes:
            result = _mfg_call_vision_endpoint(image_bytes, image_id, spec)
    if result is None:
        result = _mfg_simulate_inspect(spec)
        result["source"] = "sim"
    return jsonify({
        "image_id": image_id, "filename": spec["filename"], "part": spec["part"],
        "model": MFG_VISION_ENDPOINT or "databricks-ecoat-defect-v2",
        "uc_volume": f"/Volumes/{MFG_UC_CATALOG}/{MFG_UC_SCHEMA}/{MFG_UC_VOLUME}",
        **result,
    })


_MFG_IMPACT_DATA = {
    "insp_003": {
        "decision": "SCRAP", "severity": "HIGH",
        "machine_time": [
            {"station": "E-Coat Strip & Clean",   "minutes": 45},
            {"station": "Phosphate Pre-Treatment", "minutes": 30},
            {"station": "E-Coat Re-dip",           "minutes": 60},
            {"station": "Base Coat",               "minutes": 25},
            {"station": "Clear Coat",              "minutes": 20},
            {"station": "Final Inspection",        "minutes": 15},
        ],
        "total_minutes": 195,
        "materials": [
            {"name": "DP780 AHSS Blank (new)",        "quantity": "1 panel (18.4 kg)"},
            {"name": "Phosphate Solution",             "quantity": "2.1 L"},
            {"name": "E-Coat Bath Replenishment",      "quantity": "0.8 L"},
            {"name": "Base Coat (Silver-Blue Met.)",   "quantity": "180 mL"},
            {"name": "Clear Coat (2K HS)",             "quantity": "120 mL"},
            {"name": "Strip Solvent (methyl acetate)", "quantity": "1.5 L"},
        ],
        "estimated_cost": "$1,240",
        "summary": "HIGH severity adhesion failure — panel has delamination extending below the primer interface. Strip-and-re-coat is not viable; a new DP780 AHSS stamped blank must be sourced from stamping. Full E-Coat line cycle required on replacement.",
    },
    "insp_007": {
        "decision": "REWORK", "severity": "MEDIUM",
        "machine_time": [
            {"station": "Localised Strip & Feather", "minutes": 20},
            {"station": "Spot Phosphate Treatment",  "minutes": 15},
            {"station": "Spot E-Coat Touch-Up",      "minutes": 35},
            {"station": "Base Coat Blend",           "minutes": 20},
            {"station": "Clear Coat Blend",          "minutes": 18},
            {"station": "Final Inspection",          "minutes": 10},
        ],
        "total_minutes": 118,
        "materials": [
            {"name": "Phosphate Solution",            "quantity": "0.4 L"},
            {"name": "E-Coat Touch-Up Compound",      "quantity": "150 mL"},
            {"name": "Base Coat (Silver-Blue Met.)",  "quantity": "90 mL"},
            {"name": "Clear Coat (2K HS)",            "quantity": "70 mL"},
            {"name": "Strip Solvent (spot use)",      "quantity": "0.3 L"},
        ],
        "estimated_cost": "$385",
        "summary": "MEDIUM severity adhesion failure — defect is localised. Spot rework viable without full strip. No new steel required.",
    },
}


@app.route("/manufacturing/api/impact/<image_id>")
@login_required
def mfg_impact(image_id):
    spec = next((img for img in MFG_INSPECTION_IMAGES if img["id"] == image_id), None)
    if not spec or spec.get("ground_truth") != "defective":
        return jsonify({"error": "No defect data for this image"}), 404
    fallback = _MFG_IMPACT_DATA.get(image_id)
    try:
        host  = os.environ["DATABRICKS_HOST"].rstrip("/")
        token = os.environ["DATABRICKS_TOKEN"]
        hdrs  = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        fb    = fallback or {}
        prompt = (
            f"You are a manufacturing quality engineer at an automotive paint shop. "
            f"An E-Coat adhesion failure has been detected on a {spec['part']} "
            f"(severity: {spec.get('severity', 'MEDIUM')}, defect: {spec.get('defect', 'E-Coat Adhesion Failure')}). "
            f"Decision: {fb.get('decision', 'REWORK')}. Total rework time: {fb.get('total_minutes', 120)} minutes. "
            f"In 2 concise sentences, explain why this decision was made and what the main production risk is."
        )
        r = requests.post(
            f"{host}/serving-endpoints/{MFG_LLM_ENDPOINT}/invocations",
            headers=hdrs,
            json={"messages": [{"role": "user", "content": prompt}], "max_tokens": 120, "temperature": 0.3},
            timeout=15,
        )
        if r.status_code == 200:
            llm_summary = r.json()["choices"][0]["message"]["content"].strip()
            return jsonify({**fallback, "part": spec["part"], "image_id": image_id, "summary": llm_summary})
    except Exception:
        pass
    if fallback:
        return jsonify({**fallback, "part": spec["part"], "image_id": image_id})
    return jsonify({"error": "Impact data unavailable"}), 500


# ── PDM ────────────────────────────────────────────────────────────────────────

_MFG_PDM_PROFILES = {
    "FAL-ASM-01": {"failure_prob": 0.97, "hours_to_failure": 0.0,  "fault_count_7d": 8,  "alarm_count_24h": 12, "action": "IMMEDIATE: Replace transfer car #4 encoder (Part #TC4-ENC-200) and reset PLC sequence."},
    "BDY-WLD-01": {"failure_prob": 0.94, "hours_to_failure": 0.0,  "fault_count_7d": 6,  "alarm_count_24h": 9,  "action": "IMMEDIATE: Replace electrode tips on robots 3, 7, 14. Run weld quality audit before restart."},
    "PNT-ECT-01": {"failure_prob": 0.91, "hours_to_failure": 0.0,  "fault_count_7d": 5,  "alarm_count_24h": 8,  "action": "IMMEDIATE: Drain bath, acid-wash tank, replace with fresh CED solution. ~4 hr recovery."},
    "PTN-BLD-01": {"failure_prob": 0.87, "hours_to_failure": 0.0,  "fault_count_7d": 5,  "alarm_count_24h": 7,  "action": "IMMEDIATE: Inspect torque tooling on main bearing cap station. Replace torque transducer."},
    "BDY-SLD-01": {"failure_prob": 0.83, "hours_to_failure": 0.0,  "fault_count_7d": 4,  "alarm_count_24h": 6,  "action": "IMMEDIATE: Re-calibrate hemming die alignment. Inspect door flange tooling for wear."},
    "PTN-MCH-01": {"failure_prob": 0.62, "hours_to_failure": 8.4,  "fault_count_7d": 3,  "alarm_count_24h": 4,  "action": "URGENT (next 8 hrs): Replace boring head insert and check spindle bearing preload."},
    "PTN-DYN-01": {"failure_prob": 0.41, "hours_to_failure": 18.2, "fault_count_7d": 2,  "alarm_count_24h": 2,  "action": "MONITOR: Schedule dynamometer coupling inspection at next scheduled PM window."},
    "BDY-STM-01": {"failure_prob": 0.31, "hours_to_failure": 28.6, "fault_count_7d": 1,  "alarm_count_24h": 1,  "action": "MONITOR: Die lubrication system showing intermittent pressure drops. Check lubricant reservoir."},
    "PTN-HAD-01": {"failure_prob": 0.26, "hours_to_failure": 36.1, "fault_count_7d": 1,  "alarm_count_24h": 1,  "action": "ROUTINE: Valve clearance measurement due. Schedule at next shift change."},
    "PNT-PRP-01": {"failure_prob": 0.22, "hours_to_failure": 42.0, "fault_count_7d": 1,  "alarm_count_24h": 0,  "action": "ROUTINE: Bath pH trending toward upper limit. Plan chemistry adjustment within 48 hrs."},
    "BDY-INS-01": {"failure_prob": 0.14, "hours_to_failure": 72.0, "fault_count_7d": 0,  "alarm_count_24h": 0,  "action": "OK: No maintenance action required. Next PM in 210 hrs."},
    "PNT-BSC-01": {"failure_prob": 0.12, "hours_to_failure": 88.0, "fault_count_7d": 0,  "alarm_count_24h": 0,  "action": "OK: Spray robot arm calibration recommended at next PM."},
    "PNT-CLR-01": {"failure_prob": 0.10, "hours_to_failure": 96.0, "fault_count_7d": 0,  "alarm_count_24h": 0,  "action": "OK: Oven temperature profile nominal. No action required."},
    "PNT-INS-01": {"failure_prob": 0.08, "hours_to_failure": 120.0,"fault_count_7d": 0,  "alarm_count_24h": 0,  "action": "OK: PM in progress. Return to service after wavescan recalibration complete."},
}

def _mfg_risk_level(prob):
    if prob >= 0.80: return "CRITICAL"
    if prob >= 0.55: return "HIGH"
    if prob >= 0.30: return "MEDIUM"
    return "LOW"

def _mfg_risk_color(level):
    return {"CRITICAL": "#ef4444", "HIGH": "#f97316", "MEDIUM": "#f59e0b", "LOW": "#22c55e"}[level]

def _mfg_pdm_features_from_machine(m, profile):
    import hashlib as _hl2
    seed = int(_hl2.md5(m["id"].encode()).hexdigest()[:4], 16)
    rng  = seed / 65535.0
    return {
        "temp_c":                   _mfg_live_temp(m.get("base_temp", 40.0), m["id"]),
        "vibration_rms":            round(1.8 + profile.get("failure_prob", 0.1) * 3.2 + (rng - 0.5) * 0.3, 3),
        "spindle_load_pct":         round(min(100, m.get("base_oee", 60) * 0.9 + profile.get("failure_prob", 0.1) * 22), 1),
        "oil_pressure_bar":         round(max(0.5, 4.5 - profile.get("failure_prob", 0.1) * 2.8 + (rng - 0.5) * 0.2), 2),
        "cycle_time_deviation_pct": round(profile.get("failure_prob", 0.1) * 28.0 + (rng - 0.5) * 2.0, 2),
        "operating_hours":          round(8000 + (seed % 20000), 1),
        "hours_since_last_pm":      round(200 + profile.get("failure_prob", 0.1) * 2800, 1),
        "fault_count_7d":           profile.get("fault_count_7d", 0),
        "alarm_count_24h":          profile.get("alarm_count_24h", 0),
    }

def _mfg_pdm_simulate(machines):
    results = []
    for m in machines:
        profile = _MFG_PDM_PROFILES.get(m["id"], {"failure_prob": 0.10, "hours_to_failure": 96.0,
                                                    "fault_count_7d": 0, "alarm_count_24h": 0, "action": "OK"})
        prob  = profile["failure_prob"]
        level = _mfg_risk_level(prob)
        feats = _mfg_pdm_features_from_machine(m, profile)
        results.append({
            "machine_id":         m["id"],
            "machine_name":       m.get("name", m["id"]),
            "line":               m.get("line", "?"),
            "line_name":          m.get("line_name", ""),
            "state":              m.get("base_state", "running"),
            "failure_prob":       round(prob, 3),
            "risk_level":         level,
            "risk_color":         _mfg_risk_color(level),
            "hours_to_failure":   profile["hours_to_failure"],
            "recommended_action": profile["action"],
            "features":           feats,
        })
    return sorted(results, key=lambda x: -x["failure_prob"])


@app.route("/manufacturing/api/predict-maintenance")
@login_required
def mfg_predict_maintenance():
    machines = _mfg_gold_machine_state() or [
        {"id": m["id"], "name": m["name"], "line": m["line"],
         "line_name": m["line_name"], "base_state": m["base_state"],
         "base_oee": m["base_oee"], "base_temp": m["base_temp"]}
        for m in MFG_MACHINES_STATIC
    ]
    pdm_results = None
    if MFG_PDM_ENDPOINT:
        try:
            host  = os.environ["DATABRICKS_HOST"].rstrip("/")
            token = os.environ["DATABRICKS_TOKEN"]
            hdrs  = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            all_features = []
            for m in machines:
                profile = _MFG_PDM_PROFILES.get(m.get("id", ""), {"failure_prob": 0.10,
                    "hours_to_failure": 96.0, "fault_count_7d": 0, "alarm_count_24h": 0, "action": "OK"})
                all_features.append(_mfg_pdm_features_from_machine(m, profile))
            r = requests.post(
                f"{host}/serving-endpoints/{MFG_PDM_ENDPOINT}/invocations",
                headers=hdrs, json={"dataframe_records": all_features}, timeout=12,
            )
            if r.status_code == 200:
                raw_preds = r.json().get("predictions", [])
                pdm_results = []
                for i, m in enumerate(machines):
                    pred    = float(raw_preds[i]) if i < len(raw_preds) else 0.1
                    profile = _MFG_PDM_PROFILES.get(m.get("id", ""), {"failure_prob": pred,
                        "hours_to_failure": 96.0, "fault_count_7d": 0, "alarm_count_24h": 0, "action": "OK"})
                    level = _mfg_risk_level(pred)
                    pdm_results.append({
                        "machine_id":         m.get("id", ""),
                        "machine_name":       m.get("name", m.get("id", "")),
                        "line":               m.get("line", ""),
                        "line_name":          m.get("line_name", ""),
                        "state":              m.get("state", m.get("base_state", "running")),
                        "failure_prob":       round(pred, 3),
                        "risk_level":         level,
                        "risk_color":         _mfg_risk_color(level),
                        "hours_to_failure":   profile.get("hours_to_failure", 96.0),
                        "recommended_action": profile.get("action", "Monitor."),
                        "features":           all_features[i],
                    })
                pdm_results = sorted(pdm_results, key=lambda x: -x["failure_prob"])
        except Exception:
            pdm_results = None
    if pdm_results is None:
        pdm_results = _mfg_pdm_simulate(machines)
    summary = {
        "critical": sum(1 for r in pdm_results if r["risk_level"] == "CRITICAL"),
        "high":     sum(1 for r in pdm_results if r["risk_level"] == "HIGH"),
        "medium":   sum(1 for r in pdm_results if r["risk_level"] == "MEDIUM"),
        "low":      sum(1 for r in pdm_results if r["risk_level"] == "LOW"),
        "model":    MFG_PDM_ENDPOINT or "pdm-simulation",
        "uc_table": f"{MFG_UC_CATALOG}.mfg_gold.machine_sensor_history",
    }
    return jsonify({"machines": pdm_results, "summary": summary})


_MFG_PDM_TOP_SENSORS = {
    "FAL-ASM-01": {"key": "fault_count_7d",          "label": "7-Day Fault Count",   "unit": "faults", "threshold": 4,    "direction": "above", "threshold_label": "Alert Zone"},
    "BDY-WLD-01": {"key": "vibration_rms",            "label": "Vibration RMS",        "unit": "m/s²",   "threshold": 3.5,  "direction": "above", "threshold_label": "Failure Zone"},
    "PNT-ECT-01": {"key": "temp_c",                   "label": "Bath Temperature",     "unit": "°C",     "threshold": 62.0, "direction": "above", "threshold_label": "Overtemp Zone"},
    "PTN-BLD-01": {"key": "spindle_load_pct",         "label": "Spindle Load",         "unit": "%",      "threshold": 85.0, "direction": "above", "threshold_label": "Overload Zone"},
    "BDY-SLD-01": {"key": "cycle_time_deviation_pct", "label": "Cycle Time Deviation", "unit": "%",      "threshold": 15.0, "direction": "above", "threshold_label": "Failure Zone"},
    "PTN-MCH-01": {"key": "oil_pressure_bar",         "label": "Oil Pressure",         "unit": "bar",    "threshold": 1.8,  "direction": "below", "threshold_label": "Low Pressure Zone"},
    "PTN-DYN-01": {"key": "vibration_rms",            "label": "Vibration RMS",        "unit": "m/s²",   "threshold": 3.5,  "direction": "above", "threshold_label": "Failure Zone"},
    "BDY-STM-01": {"key": "oil_pressure_bar",         "label": "Die Lube Pressure",    "unit": "bar",    "threshold": 1.8,  "direction": "below", "threshold_label": "Low Pressure Zone"},
    "PTN-HAD-01": {"key": "cycle_time_deviation_pct", "label": "Cycle Time Deviation", "unit": "%",      "threshold": 15.0, "direction": "above", "threshold_label": "Failure Zone"},
    "PNT-PRP-01": {"key": "temp_c",                   "label": "Process Temperature",  "unit": "°C",     "threshold": 62.0, "direction": "above", "threshold_label": "Overtemp Zone"},
    "BDY-INS-01": {"key": "vibration_rms",            "label": "Vibration RMS",        "unit": "m/s²",   "threshold": 3.5,  "direction": "above", "threshold_label": "Failure Zone"},
    "PNT-BSC-01": {"key": "vibration_rms",            "label": "Vibration RMS",        "unit": "m/s²",   "threshold": 3.5,  "direction": "above", "threshold_label": "Failure Zone"},
    "PNT-CLR-01": {"key": "temp_c",                   "label": "Oven Temperature",     "unit": "°C",     "threshold": 195,  "direction": "above", "threshold_label": "Overtemp Zone"},
    "PNT-INS-01": {"key": "vibration_rms",            "label": "Vibration RMS",        "unit": "m/s²",   "threshold": 3.5,  "direction": "above", "threshold_label": "Failure Zone"},
}


@app.route("/manufacturing/api/pdm-timeseries/<machine_id>")
@login_required
def mfg_pdm_timeseries(machine_id):
    import random as _r
    profile     = _MFG_PDM_PROFILES.get(machine_id, {"failure_prob": 0.10, "hours_to_failure": 96.0,
                                                       "fault_count_7d": 0, "alarm_count_24h": 0, "action": "OK"})
    sensor_info = _MFG_PDM_TOP_SENSORS.get(machine_id, {"key": "vibration_rms", "label": "Vibration RMS",
                                                          "unit": "m/s²", "threshold": 3.5,
                                                          "direction": "above", "threshold_label": "Failure Zone"})
    import hashlib as _hl2
    prob      = profile["failure_prob"]
    threshold = sensor_info["threshold"]
    direction = sensor_info["direction"]
    key       = sensor_info["key"]
    seed      = int(_hl2.md5(machine_id.encode()).hexdigest()[:4], 16)
    _r.seed(seed)
    m_mock      = {"id": machine_id, "base_temp": 40.0 + prob * 30, "base_oee": 60}
    feats       = _mfg_pdm_features_from_machine(m_mock, profile)
    current_val = feats[key]
    if direction == "above":
        safe_val = threshold * max(0.3, (1.0 - prob) * 0.85 + (seed / 65535.0) * 0.1)
    else:
        safe_val = threshold * (1.6 + (1.0 - prob) * 0.5 + (seed / 65535.0) * 0.1)
    noise_scale = threshold * 0.025
    points = []
    for i in range(24):
        t   = (i / 23.0) ** 1.6
        val = safe_val + (current_val - safe_val) * t + (_r.random() - 0.5) * noise_scale * 2
        points.append(round(val, 2))
    points[-1] = round(current_val, 2)
    labels      = [f"{23 - i}h ago" if i < 23 else "Now" for i in range(24)]
    labels[22]  = "1h ago"
    return jsonify({
        "machine_id":      machine_id,
        "sensor":          key,
        "label":           sensor_info["label"],
        "unit":            sensor_info["unit"],
        "threshold":       threshold,
        "threshold_label": sensor_info["threshold_label"],
        "direction":       direction,
        "risk_level":      _mfg_risk_level(prob),
        "risk_color":      _mfg_risk_color(_mfg_risk_level(prob)),
        "failure_prob":    round(prob, 3),
        "labels":          labels,
        "values":          points,
        "current":         round(current_val, 2),
    })


# ── Manuals RAG ────────────────────────────────────────────────────────────────

_MFG_MANUAL_FALLBACK = [
    {"q_keywords": ["e-047", "encoder", "fault", "fal-asm"],
     "answer": ("Fault E-047 indicates a Transfer Car encoder signal loss on the FAL-ASM-01 station. "
                "Procedure: (1) Power down transfer car and engage LOTO. (2) Locate the Heidenhain ERN 420 encoder on the drive shaft (Fig 4-3). "
                "(3) Inspect cable connector for fretting — replace M12 connector if continuity test fails. "
                "(4) Replace encoder body with P/N TC-ENC-420-R and torque coupling to 2.5 Nm. "
                "(5) Run 10-cycle dry test at 20% speed before returning to production. Expected MTTR: 45 minutes."),
     "sources": ["transfer_car_assembly_manual.pdf"]},
    {"q_keywords": ["oil pressure", "die lube", "bdy-stm", "stamping"],
     "answer": ("Low die lubrication pressure on BDY-STM-01 is most commonly caused by a clogged filter or failing pump seal. "
                "Procedure: (1) Shut down press and relieve hydraulic pressure per section 7.2. (2) Replace 25-micron lube filter element (P/N STM-LBF-025). "
                "(3) Inspect pump output seal; if weeping, replace with seal kit P/N STM-PSK-800. "
                "(4) Bleed lube circuit and verify pressure ≥ 2.2 bar at die inlet before resuming."),
     "sources": ["800t_stamping_press_manual.pdf"]},
    {"q_keywords": ["welding", "robot", "fanuc", "r-2000", "maintenance", "pm"],
     "answer": ("Scheduled PM for FANUC R-2000iC welding robot (every 3,840 hours): "
                "(1) Grease all six axes with Mobil Unirex N3. (2) Check teach pendant cable for kinks. "
                "(3) Clean TCP spatter shield and verify TCP calibration. "
                "(4) Inspect wrist unit for oil weepage — acceptable limit < 0.5 g/day. "
                "(5) Test all axis brakes per J7 test spec. (6) Back up controller parameters to CF card."),
     "sources": ["fanuc_r2000ic_welding_robot_manual.pdf"]},
    {"q_keywords": ["e-coat", "electrocoat", "paint", "rectifier", "voltage"],
     "answer": ("E-Coat rectifier over-voltage alarm (Code EC-OV): (1) Check bath conductivity — target 1,200–1,600 µS/cm. "
                "(2) Inspect anode bags for rupture; replace any showing paint contamination. "
                "(3) Verify rectifier cooling water flow ≥ 15 L/min. "
                "(4) If alarm persists, reduce ramp rate from 250 V/s to 180 V/s in PLC recipe."),
     "sources": ["e_coat_system_manual.pdf"]},
    {"q_keywords": ["vision", "inspection", "camera", "false reject", "calibration"],
     "answer": ("High false-reject rate on Vision Inspection System: (1) Clean all eight camera lenses with IPA wipe. "
                "(2) Run white-balance calibration tile routine (Menu → Calibration → White Balance). "
                "(3) Verify strobe sync pulse is within ±5 µs of trigger. "
                "(4) If defect-classification confidence < 92%, retrain model with last 500 manually verified images."),
     "sources": ["vision_inspection_system_manual.pdf"]},
]

def _mfg_manual_fallback_answer(question: str) -> dict:
    q_lower = question.lower()
    best_score, best = 0, _MFG_MANUAL_FALLBACK[0]
    for item in _MFG_MANUAL_FALLBACK:
        score = sum(1 for kw in item["q_keywords"] if kw in q_lower)
        if score > best_score:
            best_score, best = score, item
    return {"answer": best["answer"], "sources": best["sources"], "simulated": True}


@app.route("/manufacturing/api/manuals-query", methods=["POST"])
@login_required
def mfg_manuals_query():
    data     = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    if not question:
        return jsonify({"error": "question is required"}), 400
    try:
        host  = os.environ["DATABRICKS_HOST"].rstrip("/")
        token = os.environ["DATABRICKS_TOKEN"]
        hdrs  = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        resp  = requests.post(
            f"{host}/serving-endpoints/{MFG_MANUALS_ENDPOINT}/invocations",
            headers=hdrs, json={"dataframe_records": [{"question": question}]}, timeout=30,
        )
        if resp.status_code == 200:
            result = resp.json()
            pred   = result.get("predictions", result)
            if isinstance(pred, list):
                pred = pred[0]
            return jsonify({"answer": pred.get("answer", ""), "sources": pred.get("sources", []), "simulated": False})
    except Exception:
        pass
    return jsonify(_mfg_manual_fallback_answer(question))


@app.route("/manufacturing/api/log-page-time", methods=["POST"])
@login_required
def mfg_log_page_time():
    data    = request.get_json(silent=True) or {}
    page    = str(data.get("page", ""))[:64]
    seconds = int(data.get("seconds_spent", 0))
    user    = session.get("username", "anonymous")
    company = session.get("company_name", "")
    _delta_log_write(
        f"INSERT INTO {LOG_CATALOG}.{LOG_SCHEMA}.page_time_log "
        "(username, company_name, page, seconds_spent, app_name, recorded_at) "
        "VALUES (%s, %s, %s, %s, %s, current_timestamp())",
        (user, company, page, seconds, "Manufacturing Intelligence"),
    )
    _sheets_log_write({"type": "page_view", "username": user, "company_name": company,
                       "page": page, "seconds_spent": seconds, "app_name": "Manufacturing Intelligence"})
    return jsonify({"status": "ok"})


# ══════════════════════════════════════════════════════════════════════════════
# FINANCE — /finance/
# ══════════════════════════════════════════════════════════════════════════════

FIN_GENIE_SPACE_ID = os.getenv("FIN_GENIE_SPACE_ID", "")
FIN_WAREHOUSE_ID   = os.getenv("FIN_WAREHOUSE_ID", "")
FIN_CATALOG        = os.getenv("FIN_CATALOG", "demo_nah_catalog")
FIN_GOLD_SCHEMA    = os.getenv("FIN_GOLD_SCHEMA", "finance_gold")
FIN_GOOGLE_API_KEY = os.getenv("FIN_GOOGLE_API_KEY", "")


# ── Finance helpers ────────────────────────────────────────────────────────────

def _fin_headers():
    return {"Authorization": f"Bearer {DATABRICKS_TOKEN}", "Content-Type": "application/json"}


def _fin_sql(query: str) -> tuple[bool, list]:
    """Execute SQL on Databricks SQL Warehouse and return (ok, rows)."""
    try:
        r = requests.post(
            f"{DATABRICKS_HOST.rstrip('/')}/api/2.0/sql/statements",
            headers=_fin_headers(),
            json={"statement": query, "warehouse_id": FIN_WAREHOUSE_ID, "wait_timeout": "30s"},
            timeout=35,
        )
        if r.status_code != 200:
            return False, []
        data = r.json()
        cols     = [c["name"] for c in (data.get("manifest", {}).get("schema", {}).get("columns") or [])]
        rows_raw = data.get("result", {}).get("data_array") or []
        return True, [dict(zip(cols, row)) for row in rows_raw]
    except Exception:
        return False, []


def _fin_genie_ask(question: str) -> tuple[bool, str]:
    """Ask a question to the Finance Genie space and poll for the answer."""
    base = DATABRICKS_HOST.rstrip("/")
    try:
        r = requests.post(
            f"{base}/api/2.0/genie/spaces/{FIN_GENIE_SPACE_ID}/start-conversation",
            json={"content": question},
            headers=_fin_headers(),
            timeout=30,
        )
        if r.status_code not in (200, 201):
            return False, r.text or str(r.status_code)
        resp = r.json()
    except Exception as e:
        return False, str(e)

    conversation_id = resp.get("conversation_id") or (resp.get("conversation", {}) or {}).get("id")
    message_id      = resp.get("message_id")      or (resp.get("message",       {}) or {}).get("id")
    if not conversation_id or not message_id:
        return False, "Unexpected Genie response"

    poll_url = f"{base}/api/2.0/genie/spaces/{FIN_GENIE_SPACE_ID}/conversations/{conversation_id}/messages/{message_id}"
    for _ in range(60):
        time.sleep(2)
        try:
            p  = requests.get(poll_url, headers=_fin_headers(), timeout=30)
            st = p.json() if p.text else {}
        except Exception as e:
            return False, str(e)
        status = st.get("status")
        if status == "COMPLETED":
            parts = []
            for att in (st.get("attachments") or []):
                if isinstance(att, dict):
                    txt = att.get("text", {})
                    parts.append(txt.get("content", "") if isinstance(txt, dict) else str(txt))
            answer = "\n\n".join(p for p in parts if p).strip()
            query_result = None
            for att in (st.get("attachments") or []):
                if isinstance(att, dict) and att.get("query"):
                    q_obj = att["query"]
                    query_result = {
                        "sql":         q_obj.get("query", ""),
                        "description": q_obj.get("description", ""),
                    }
            return True, json.dumps({"answer": answer or "No data returned.", "query": query_result})
        if status in ("FAILED", "CANCELLED"):
            return False, f"Query failed: {st.get('error', '')}"
    return False, "Query timed out"


_FIN_BRIEFING_FALLBACK = (
    "Q1 2025 fleet performance: North America is tracking 3.2% above revenue plan at $214M "
    "with EBITDA margin of 24.1%. EMEA is 1.8% below budget driven by FX headwinds. "
    "Specialty continues strong growth at +8.4% YoY. Working capital is healthy — DSO improved "
    "to 38 days vs 44 days prior year. Free cash flow YTD stands at $87M across all entities."
)


def _fin_gemini_briefing(kpi_context: str) -> str:
    if not FIN_GOOGLE_API_KEY:
        return _FIN_BRIEFING_FALLBACK
    try:
        import google.generativeai as genai
        genai.configure(api_key=FIN_GOOGLE_API_KEY)
        model = genai.GenerativeModel("gemini-2.0-flash")
        prompt = f"""You are a CFO. Based on the following financial KPI data,
write a concise 4-sentence executive briefing covering: (1) overall revenue vs plan,
(2) EBITDA margin health, (3) one working capital insight, (4) one risk or action item.
Be specific with numbers. Use a confident, executive tone.

Financial Data:
{kpi_context}"""
        resp = model.generate_content(prompt)
        return resp.text.strip()
    except Exception:
        return _FIN_BRIEFING_FALLBACK


def _fin_gemini_answer_context(question: str, genie_answer: str) -> str:
    """Use Gemini to add financial context/interpretation to a Genie data answer."""
    if not FIN_GOOGLE_API_KEY:
        return ""
    try:
        import google.generativeai as genai
        genai.configure(api_key=FIN_GOOGLE_API_KEY)
        model = genai.GenerativeModel("gemini-2.0-flash")
        prompt = f"""You are a senior financial analyst.
A CFO asked: "{question}"

The data system returned: "{genie_answer}"

In 2-3 sentences, provide brief financial interpretation and context for this answer.
Focus on what it means for the business, any benchmarks to be aware of, or recommended actions.
Be concise and specific. Do not repeat the raw numbers — interpret them."""
        resp = model.generate_content(prompt)
        return resp.text.strip()
    except Exception:
        return ""


# ── Finance routes ─────────────────────────────────────────────────────────────

@app.route("/finance/")
@login_required
def fin_index():
    return send_from_directory(str(STATIC_DIR / "finance"), "index.html")


@app.route("/finance/api/kpis")
@login_required
def fin_kpis():
    ok, rows = _fin_sql(f"""
        SELECT
            ROUND(SUM(actual_revenue) / 1e6, 1)                               AS total_revenue_m,
            ROUND(SUM(actual_ebitda)  / 1e6, 1)                               AS total_ebitda_m,
            ROUND(SUM(actual_ebitda) / NULLIF(SUM(actual_revenue), 0) * 100, 1) AS ebitda_margin_pct,
            ROUND(SUM(revenue_variance) / 1e6, 1)                             AS revenue_vs_budget_m
        FROM {FIN_CATALOG}.{FIN_GOLD_SCHEMA}.gold_cfo_p_and_l_summary
        WHERE fiscal_year = 2025 AND fiscal_quarter = 1
    """)
    if ok and rows:
        r = rows[0]
        return jsonify({
            "revenue":        f"${r.get('total_revenue_m', 0)}M",
            "ebitda":         f"${r.get('total_ebitda_m', 0)}M",
            "ebitda_margin":  f"{r.get('ebitda_margin_pct', 0)}%",
            "vs_budget":      f"${r.get('revenue_vs_budget_m', 0)}M",
            "vs_budget_sign": "+" if float(r.get("revenue_vs_budget_m", 0) or 0) >= 0 else "",
        })
    return jsonify({"revenue": "$509M", "ebitda": "$118M", "ebitda_margin": "23.2%",
                    "vs_budget": "+$16M", "vs_budget_sign": "+"})


@app.route("/finance/api/pl-trend")
@login_required
def fin_pl_trend():
    ok, rows = _fin_sql(f"""
        SELECT period_key, fiscal_year, fiscal_quarter,
               ROUND(SUM(actual_revenue)/1e6, 1) AS revenue_m,
               ROUND(SUM(actual_ebitda)/1e6, 1)  AS ebitda_m,
               ROUND(SUM(actual_ebitda)/NULLIF(SUM(actual_revenue),0)*100,1) AS margin_pct
        FROM {FIN_CATALOG}.{FIN_GOLD_SCHEMA}.gold_cfo_p_and_l_summary
        GROUP BY period_key, fiscal_year, fiscal_quarter
        ORDER BY fiscal_year, fiscal_quarter
    """)
    if ok and rows:
        return jsonify(rows)
    return jsonify([
        {"period_key":"FY2023-Q1","revenue_m":435.2,"ebitda_m":94.1, "margin_pct":21.6},
        {"period_key":"FY2023-Q2","revenue_m":468.5,"ebitda_m":102.4,"margin_pct":21.9},
        {"period_key":"FY2023-Q3","revenue_m":480.1,"ebitda_m":109.8,"margin_pct":22.9},
        {"period_key":"FY2023-Q4","revenue_m":549.3,"ebitda_m":128.2,"margin_pct":23.3},
        {"period_key":"FY2024-Q1","revenue_m":452.6,"ebitda_m":101.2,"margin_pct":22.4},
        {"period_key":"FY2024-Q2","revenue_m":488.9,"ebitda_m":112.5,"margin_pct":23.0},
        {"period_key":"FY2024-Q3","revenue_m":503.4,"ebitda_m":117.2,"margin_pct":23.3},
        {"period_key":"FY2024-Q4","revenue_m":572.8,"ebitda_m":136.0,"margin_pct":23.7},
        {"period_key":"FY2025-Q1","revenue_m":509.4,"ebitda_m":118.2,"margin_pct":23.2},
    ])


@app.route("/finance/api/working-capital")
@login_required
def fin_working_capital():
    ok, rows = _fin_sql(f"""
        SELECT region,
               ROUND(avg_dso, 1) AS dso,
               ROUND(avg_dpo, 1) AS dpo,
               ROUND(cash_conversion_cycle, 1) AS ccc,
               ROUND(ar_90_plus_pct, 1) AS ar_90_plus_pct
        FROM {FIN_CATALOG}.{FIN_GOLD_SCHEMA}.gold_working_capital_health
        WHERE fiscal_year = 2025 AND fiscal_quarter = 1
        ORDER BY region
    """)
    if ok and rows:
        return jsonify(rows)
    return jsonify([
        {"region":"North America","dso":38.2,"dpo":52.4,"ccc":-14.2,"ar_90_plus_pct":4.1},
        {"region":"EMEA",         "dso":44.5,"dpo":48.1,"ccc":-3.6, "ar_90_plus_pct":6.8},
        {"region":"APAC",         "dso":52.1,"dpo":41.3,"ccc":10.8, "ar_90_plus_pct":9.2},
    ])


@app.route("/finance/api/cash-flow")
@login_required
def fin_cash_flow():
    ok, rows = _fin_sql(f"""
        SELECT period_key,
               ROUND(operating_cash_flow/1e6, 1)  AS operating_cf,
               ROUND(capital_expenditures/1e6, 1) AS capex,
               ROUND(free_cash_flow/1e6, 1)       AS fcf
        FROM {FIN_CATALOG}.{FIN_GOLD_SCHEMA}.gold_cash_flow_summary
        ORDER BY fiscal_year, fiscal_quarter
    """)
    if ok and rows:
        return jsonify(rows)
    return jsonify([
        {"period_key":"FY2023-Q1","operating_cf":82.4, "capex":-24.1,"fcf":58.3},
        {"period_key":"FY2023-Q2","operating_cf":98.2, "capex":-26.4,"fcf":71.8},
        {"period_key":"FY2023-Q3","operating_cf":105.6,"capex":-22.8,"fcf":82.8},
        {"period_key":"FY2023-Q4","operating_cf":132.1,"capex":-28.3,"fcf":103.8},
        {"period_key":"FY2024-Q1","operating_cf":88.7, "capex":-23.5,"fcf":65.2},
        {"period_key":"FY2024-Q2","operating_cf":110.4,"capex":-25.1,"fcf":85.3},
        {"period_key":"FY2024-Q3","operating_cf":118.9,"capex":-24.6,"fcf":94.3},
        {"period_key":"FY2024-Q4","operating_cf":142.3,"capex":-27.4,"fcf":114.9},
        {"period_key":"FY2025-Q1","operating_cf":104.8,"capex":-21.3,"fcf":83.5},
    ])


@app.route("/finance/api/cost-centers")
@login_required
def fin_cost_centers():
    ok, rows = _fin_sql(f"""
        SELECT cost_center, department,
               ROUND(budget_amount/1e6, 1)                    AS budget_m,
               ROUND(actual_amount/1e6, 1)                    AS actual_m,
               ROUND((budget_amount - actual_amount)/1e6, 1)  AS variance_m
        FROM {FIN_CATALOG}.{FIN_GOLD_SCHEMA}.gold_cost_center_summary
        WHERE fiscal_year = 2025 AND fiscal_quarter = 1
        ORDER BY ABS(budget_amount - actual_amount) DESC
    """)
    if ok and rows:
        return jsonify(rows)
    return jsonify([
        {"cost_center":"Sales & Marketing",       "department":"Commercial", "budget_m":48.2,"actual_m":45.8,"variance_m": 2.4},
        {"cost_center":"Research & Development",  "department":"Technology", "budget_m":62.5,"actual_m":67.1,"variance_m":-4.6},
        {"cost_center":"General & Administrative","department":"Corporate",  "budget_m":22.1,"actual_m":24.3,"variance_m":-2.2},
        {"cost_center":"Supply Chain Operations", "department":"Operations", "budget_m":35.8,"actual_m":34.2,"variance_m": 1.6},
        {"cost_center":"Manufacturing",           "department":"Operations", "budget_m":88.4,"actual_m":89.7,"variance_m":-1.3},
        {"cost_center":"IT & Digital",            "department":"Technology", "budget_m":18.6,"actual_m":17.9,"variance_m": 0.7},
        {"cost_center":"Finance & Accounting",    "department":"Corporate",  "budget_m":12.4,"actual_m":12.1,"variance_m": 0.3},
        {"cost_center":"Human Resources",         "department":"Corporate",  "budget_m": 9.8,"actual_m":10.4,"variance_m":-0.6},
    ])


@app.route("/finance/api/gemini/briefing", methods=["POST"])
@login_required
def fin_gemini_briefing():
    ok, pl_rows = _fin_sql(f"""
        SELECT business_unit, region,
               ROUND(actual_revenue/1e6,1)       AS rev_m,
               ROUND(actual_ebitda/1e6,1)        AS ebitda_m,
               ROUND(actual_ebitda_margin,1)     AS ebitda_margin,
               ROUND(revenue_variance_pct,1)     AS rev_var_pct,
               ROUND(yoy_revenue_growth_pct,1)   AS yoy_pct
        FROM {FIN_CATALOG}.{FIN_GOLD_SCHEMA}.gold_cfo_p_and_l_summary
        WHERE fiscal_year=2025 AND fiscal_quarter=1
        ORDER BY actual_revenue DESC LIMIT 10
    """)
    ok2, wc_rows = _fin_sql(f"""
        SELECT region, ROUND(avg_dso,1) AS dso, ROUND(cash_conversion_cycle,1) AS ccc
        FROM {FIN_CATALOG}.{FIN_GOLD_SCHEMA}.gold_working_capital_health
        WHERE fiscal_year=2025 AND fiscal_quarter=1
    """)
    context  = f"P&L Q1 2025: {json.dumps(pl_rows or [])}\nWorking Capital: {json.dumps(wc_rows or [])}"
    briefing = _fin_gemini_briefing(context)
    return jsonify({"briefing": briefing})


@app.route("/finance/api/genie/ask", methods=["POST"])
@login_required
def fin_genie_ask():
    question = (request.get_json() or {}).get("question", "").strip()
    if not question:
        return jsonify({"error": "question required"}), 400

    ok, raw = _fin_genie_ask(question)
    if not ok:
        q_lower = question.lower()
        if any(w in q_lower for w in ["ebitda", "budget"]):
            raw = json.dumps({"answer": "EBITDA for Q1 2025: North America $62.1M (24.1% margin, +4.2% vs budget). EMEA $38.4M (22.8%, -2.1% vs budget). Specialty $17.7M (28.3%, +1.8% vs budget).", "query": None})
            ok  = True
        elif any(w in q_lower for w in ["revenue", "growth"]):
            raw = json.dumps({"answer": "Q1 2025 total revenue: $509.4M. YoY growth: +12.6% NA, +9.4% EMEA, +18.2% Specialty.", "query": None})
            ok  = True
        elif any(w in q_lower for w in ["cash", "flow", "fcf"]):
            raw = json.dumps({"answer": "Free cash flow YTD: US entity $61.2M, EMEA $18.4M, APAC $7.6M. Total: $87.2M.", "query": None})
            ok  = True
        elif any(w in q_lower for w in ["ar", "receivable", "dso"]):
            raw = json.dumps({"answer": "DSO Q1 2025: North America 38.2 days, EMEA 44.5 days, APAC 52.1 days. AR over 90 days: $12.4M (5.2% of total AR).", "query": None})
            ok  = True
        elif any(w in q_lower for w in ["cost center", "over"]):
            raw = json.dumps({"answer": "Top over-budget cost centers Q1 2025: NA Manufacturing (+$2.1M, +8.4%), EMEA Marketing (+$1.4M, +12.1%), NA IT (+$0.8M, +9.7%).", "query": None})
            ok  = True
        else:
            raw = json.dumps({"answer": "Based on Q1 2025 data across all business units, the company is performing ahead of plan on revenue (+3.2%) with strong EBITDA margin of 23.2%.", "query": None})
            ok  = True

    try:
        parsed = json.loads(raw) if ok else {}
    except Exception:
        parsed = {"answer": raw, "query": None}

    answer_text    = parsed.get("answer", raw)
    gemini_context = _fin_gemini_answer_context(question, answer_text) if ok else ""

    return jsonify({
        "ok":             ok,
        "answer":         answer_text,
        "query":          parsed.get("query"),
        "gemini_context": gemini_context,
    })


@app.route("/finance/api/log-page-time", methods=["POST"])
@login_required
def fin_log_page_time():
    data    = request.get_json(silent=True) or {}
    page    = str(data.get("page", ""))[:64]
    seconds = int(data.get("seconds_spent", 0))
    user    = session.get("username", "anonymous")
    company = session.get("company_name", "")
    _delta_log_write(
        f"INSERT INTO {LOG_CATALOG}.{LOG_SCHEMA}.page_time_log "
        "(username, company_name, page, seconds_spent, app_name, recorded_at) "
        "VALUES (%s, %s, %s, %s, %s, current_timestamp())",
        (user, company, page, seconds, "Finance Intelligence"),
    )
    _sheets_log_write({"type": "page_view", "username": user, "company_name": company,
                       "page": page, "seconds_spent": seconds, "app_name": "Finance Intelligence"})
    return jsonify({"status": "ok"})


# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
