#!/usr/bin/env bash
# Make the seeded "Tab402 Demo Sellers" belong to your web account, so the seller pages
# (Selling, Seller analytics, Webhooks) show the traffic from the buyer walkthrough.
#   ./demo/link-seller.sh [email]      default: buyer@example.com
# Run it after signing up, before clicking "Become a seller".
set -euo pipefail
cd "$(dirname "$0")/.."
email=${1:-buyer@example.com}
docker compose exec -T db psql -U tab402 -d tab402 -v ON_ERROR_STOP=1 -v email="$email" <<'SQL'
\set QUIET on
update sellers set user_id = (select id from "user" where email = :'email')
where name = 'Tab402 Demo Sellers'
  and exists (select 1 from "user" where email = :'email');
\set QUIET off
select case when count(*) = 1 then 'Linked: Tab402 Demo Sellers now belongs to ' || :'email'
            else 'No account for ' || :'email' || ' yet. Sign up in the web app first.' end as result
from sellers s join "user" u on u.id = s.user_id
where s.name = 'Tab402 Demo Sellers' and u.email = :'email';
SQL
