"""Minimal client for the Valio Aimo Junction 2026 mock APIs.

Set AIMO_API_KEY (from the Junction platform) before use:
    export AIMO_API_KEY=...
    python3 aimo_api.py 460013 460063
"""
import json
import os
import sys
import urllib.request
from datetime import date, timedelta

BASE = "https://junction26.valioaimo.fi/api"
MAX_BATCH = 1000


def _call(method, path, body=None):
    key = os.environ.get("AIMO_API_KEY")
    if not key:
        raise SystemExit("Set AIMO_API_KEY (from the Junction platform)")
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-API-Key": key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def _batched(path, products, requested_date, customer):
    out = []
    for i in range(0, len(products), MAX_BATCH):
        res = _call("POST", path, {
            "customer": customer,
            "requestedDate": str(requested_date),
            "products": [str(p) for p in products[i:i + MAX_BATCH]],
        })
        out.extend(res["products"])
    return out


def ping():
    return _call("GET", "/ping")


def price(products, requested_date=None, customer="123"):
    return _batched("/price", products, requested_date or date.today() + timedelta(days=1), customer)


def availability(products, requested_date=None, customer="123"):
    return _batched("/availability", products, requested_date or date.today() + timedelta(days=1), customer)


if __name__ == "__main__":
    ids = sys.argv[1:] or ["460013", "460063"]
    print(json.dumps(ping(), indent=1))
    print(json.dumps(price(ids), indent=1))
    print(json.dumps(availability(ids), indent=1))
