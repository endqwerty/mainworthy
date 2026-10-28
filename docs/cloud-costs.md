# Google Cloud costs in us-west1

Read 2026-10-25, setup as of 2026-10-26: one Cloud Run service and one database. USD on-demand list prices, 730
hours per month, no committed-use discount or promotional credit. These are calculations from public prices, not a
measured bill. Free allowances are shared with the billing account's other projects. The registry stores only the
images Cloud Run pulls through it from GHCR, at Artifact Registry's storage price.

| Resource | Monthly price or usage rate | Source |
| --- | --- | --- |
| Production Cloud SQL, zonal Enterprise `db-f1-micro` | 730 × $0.0105 = $7.665 | [SQL pricing, Oregon](https://cloud.google.com/sql/pricing) |
| Production SSD, initially 10 GiB | $1.70 at $0.17/GiB-month | [SQL pricing](https://cloud.google.com/sql/pricing) |
| Production retained standard backups | $0.08 per average retained GiB-month, $0.80 for 10 GiB | [SQL pricing](https://cloud.google.com/sql/pricing) |
| Production PITR logs, seven days | Included for a new Enterprise instance with PITR enabled | [PITR log storage](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/restore) |
| Production Query Insights | $0 on Enterprise; its Cloud SQL metrics are Google Cloud metrics, which are not charged | [Query Insights](https://docs.cloud.google.com/sql/docs/postgres/using-query-insights) |
| The app, one idle minimum instance, 1 vCPU and 512 MiB, excluding proxy | $9.855 before credits. CPU and RAM each $0.0000025 per allocated unit-second while idle | [Run request-based pricing](https://cloud.google.com/run/pricing) |
| Proxy, 1 vCPU and 128 MiB per instance | Adds $7.39125/month to the idle minimum instance | [Run pricing](https://cloud.google.com/run/pricing) |
| Active preview Run services | $0 idle reservation at minimum zero. Reprice their allocated CPU, RAM and active seconds when created | [Run pricing](https://cloud.google.com/run/pricing) |
| Attachments and app Terraform state | Regional Standard $0.02/GiB-month. Class A $0.005/1,000 and Class B $0.0004/1,000 operations | [Storage pricing](https://cloud.google.com/storage/pricing) |
| Artifact Registry | $0.10/GiB-month, first 0.5 GiB free. A retained 1 GiB is $0.05 after allowance | [Registry pricing](https://cloud.google.com/artifact-registry/pricing) |
| Four Secret Manager containers | $0. Versions cost $0.06/version/location-month, six free. Access $0.03/10,000, first 10,000 free | [Secret pricing](https://cloud.google.com/secret-manager/pricing) |
| One Cloud Scheduler job | $0 if one of the account's three free jobs, otherwise $0.10 per 31 days, about $0.098 for 730 hours | [Scheduler pricing](https://cloud.google.com/scheduler/pricing) |
| VPC, subnet, internal addresses, private services access, Direct VPC egress | $0 fixed reservation here. No VPC connector or NAT. Network bytes can cost extra | [VPC pricing](https://cloud.google.com/vpc/pricing), [Direct VPC](https://docs.cloud.google.com/run/docs/configuring/connecting-vpc) |
| Ordinary Cloud Logging | $0.50/GiB after 50 GiB per project/month. Thirty days retained without extra retention charge | [Observability pricing](https://cloud.google.com/products/observability/pricing) |
| IAM accounts, WIF, API enables | No fixed resource fee. Their service usage is billed above | [IAM pricing](https://cloud.google.com/iam/pricing) |

The database, its disk, 10 billable GiB of backups and 1 GiB of retained images come to about $10.22 a month. The
app plus proxy at idle reserve $17.25 before credits; Run's shared monthly CPU and RAM discounts take off at most
$5.22, so the idle baseline is about $22.24 with allowances and $27.46 without. The Scheduler's minute tick keeps the
instance active for each request: at about 0.3 s per tick, roughly 3.7 active hours a month, about $0.57 more. These
durations are estimates, not measurements. Before 2026-10-26 the setup also had a preview database ($9.37 with its
disk) and a separate job service.

Active CPU costs $0.000024/vCPU-second. Each active hour on the app plus proxy adds $0.1548 over
idle CPU. A change stream is an open request and keeps CPU billable. Continuous activity can therefore add
$113.00/month before jobs or previews. The request charge is $0.40/million after two million free requests.

Storage's shared free tier covers 5 GB-months and limited operations in eligible US regions, including Oregon.
Object versions, seven-day soft deletion, backup bytes, state history and registry history all grow the bill.
SQL disks automatically grow and do not shrink. Shared-core SQL has no SLA. Restore drills create another
billable SQL instance. Foundation audit-log retention, external mail and telemetry, taxes and scanning are extra.

Budget $0.01/GiB for cross-zone Run-to-SQL traffic until the actual path and SKU are checked. Public Run responses
to Cloudflare still incur Google internet egress, typically $0.12/GiB for the first paid North American tier.
Same-region registry pulls and bucket reads avoid cross-region transfer. See [VPC transfer pricing](https://cloud.google.com/vpc/pricing#internet_data_transfer_rates).
A load balancer, Cloud Armor, NAT or a connector is outside this setup and needs a new estimate before creation.
The budget alert warns about spend; it does not cap it.
