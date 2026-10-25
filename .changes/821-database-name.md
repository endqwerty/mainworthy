---
id: 821-database
category: Fixed
date: 2026-10-25
issue: https://github.com/endqwerty/mainworthy/issues/821
---
On Coolify the server never started after the move to PostgreSQL: Coolify's shared network has a second `postgres`, its own database, and the app resolved the name to an address there that the network lockdown then blocked. The app now names its database `mainworthy-database`, an alias only the internal database network knows.
