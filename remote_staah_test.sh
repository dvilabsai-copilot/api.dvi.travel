#!/usr/bin/env bash
set -e
URL="https://channelconnect.otaswitch.com/common-cgi/dviholidays/test/services.pl"
echo "Server: $(hostname)"
echo "GET request"
curl -sS -o /tmp/staah_get_body.txt -D /tmp/staah_get_headers.txt -w "HTTP_STATUS:%{http_code}\n" "$URL" || true
head -n 20 /tmp/staah_get_headers.txt || true
echo "POST request"
curl -sS -o /tmp/staah_post_body.txt -D /tmp/staah_post_headers.txt -H "Content-Type: application/json" -X POST -d '{}' -w "HTTP_STATUS:%{http_code}\n" "$URL" || true
head -n 20 /tmp/staah_post_headers.txt || true
echo "POST body preview"
head -c 500 /tmp/staah_post_body.txt || true
echo
