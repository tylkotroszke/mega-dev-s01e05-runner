# Signed agent runtime

## Current contract-fix-v1 behavior

Pulse reads the live tracker, quotes the ping phrase, names a relevant open
issue and recommends the next step. Issue author is not an admission rule.
There is no word blacklist, separate 500-character phrase cap or 1400-character
recommendation cap. The controller adds phrase/issue facts; the model supplies
a recommendation through native structured JSON. The complete pulse response
has the course's 2000-character limit. Direct false completion claims still
violate the course rule. Delivered stop messages have their own outcome/code.

The test writer handles the open issue named by the authenticated ping. The
generator, protocol and sandbox share the complete 20000-byte UTF-8 response
budget. Dotted/nested test names and dynamic source imports are supported.
Model-supplied red is ignored; the isolated trusted controller measures red
on the unchanged base. More than one case in the new test file is allowed.

There is no harness daily task quota, model-call counter, output-token quota,
custom source/file-count cap, 15-minute lease expiry or sandbox CPU/RAM/PID/
output quota. Hosting/provider limits still exist: D1 documents a 2000000-byte
string/row boundary, so the ingress maximum follows that physical boundary.
The disposable GitHub VM and Docker defaults bound execution resources.
Network isolation, read-only base mounts, a private report and demoted test
identities remain. No generated test is run on the owner's computer.

Both model roles use a total 300-second generation deadline. Transient 408,
429, 5xx and transport failures retry on the same configured model with
exponential backoff starting at 1s (up to 60s), 0.5-1.5 jitter and Retry-After.
Retries share that total deadline. Permanent errors and invalid model JSON
are not retried. No fallback or billing changes occur. Normal signed jobs
are not restricted to one provider request. Historical manually approved
synthetic check scripts retain their own one-shot scope only.

The owner-reviewed 10-minute GitHub job deadline remains; setup, generation,
sandbox (up to 300s) and transport share that job lifetime. Reaching every
stage's maximum cannot be guaranteed within that overall lifetime.

Only a new authentic course webhook copy may retry a known failed GitHub
dispatch; its atomic one-use lease still prevents duplicate model processing.
Uncertain dispatches and uncertain course replies are never blindly resent.

## Deployment

Use deploy-contract.yml at the immutable contract-fix-v1 tag, after approval.
It verifies unit tests and the real synthetic Docker check on GitHub Ubuntu
without secrets, then uses the existing deployment Environment for one Worker
module upload plus RUNNER_REF promotion. All other bindings/settings and
persisted logs stay unchanged and agents stay ON. It performs no model call
or course claim. Private test-writer instructions are updated separately by
the owner-reviewed guarded database statement, never published in this repo.

## Historical implementation notes

Everything below describes earlier immutable tags, not current runtime rules.
Do not reapply old OFF instructions, quotas or one-call budgets.

## Prepared writer deadline and diagnostics fix

The writer's single Gemini request may
take up to 300 seconds; pulse retains 60 seconds. The proposed workflow has a
10-minute overall deadline. The writer budget leaves time for the existing
45-second isolated test, result transport and controller work. Build/setup time
also consumes that overall deadline; no hard completion guarantee is implied.
These are controller settings, not course requirements or daily task quotas.

The runner emits fixed stage names, elapsed milliseconds and whitelisted failure
codes. Model failures distinguish timeout, HTTP status, transport, invalid JSON,
blocked output and incomplete output. Sandbox timeout has its own code. Logs
never include remote error text, request/response bodies, source, test output,
URLs, headers or credentials. Only controller-created errors carry metadata.
The original exception is still not printed. No model retry, fallback or extra
request is added. Worker, D1, secrets, logs and ON settings are unchanged.

The owner-reviewed `writer-fix-v1` tag uses `deploy-writer.yml`. Its first job
runs unit tests, builds the trusted toolchain and runs a synthetic isolated
red-green control on GitHub Ubuntu, without an Environment or secrets. Only a
successful verification permits the second job to use `mega-s01e05-deploy`.
That job makes one PATCH to the existing Worker's settings, changing only
RUNNER_REF from no-cap-v1 to writer-fix-v1. Every other binding is inherited
by name. The latest Worker version must already serve 100% of traffic; no
undeployed version is used as an inheritance source. Persisted invocation logs,
all other protected settings and enabled public endpoints are checked before
and after. No Worker code upload, model call, course claim or automatic rollback
is part of the deployment workflow. On error the job stops and agents stay ON.

## Daily task quota removed

Production admission has no harness-defined daily task count. The Worker and
SQLite reservation code do not read MAX_JOBS_PER_DAY; historical and failed
jobs cannot block later unique signed pings. Signature checks, unique webhook
deduplication, one-use leases and the original course reply destination remain.
Provider free-tier quotas still apply. There is no paid model fallback.

The agents workflow does not share a custom concurrency group: distinct jobs
use GitHub's normal scheduling instead of replacing a single pending run.

The reviewed no-cap-v1 runtime tag and deployment keep existing agents ON, preserve all
secrets, D1 and logs, then allows the owner-approved removal of the obsolete
MAX_JOBS_PER_DAY variable. It does not run a model, dispatch another connection
probe or submit a course claim. Older diagnostic deployment sections below
describe historical tags and are not the current deployment procedure.

Generic signed-webhook transport and bounded model agents. This directory
contains no application source, fixtures, private plans or credentials.
Those arrive through a private authenticated job channel at runtime.

Deployment is disabled by default. Both Worker AUTONOMOUS_REPLIES_ENABLED
and GitHub Environment LIVE_EXECUTION_ENABLED require explicit owner approval.
Do not use a repository secret instead of the selected Environment.

## One-use connection check

Worker subrequests use Cloudflare-supported `redirect: "manual"` and reject
unexpected 3xx statuses without following Location. Node-only controllers and
deployment scripts retain standard `redirect: "error"`. Regression tests model
the documented Cloudflare rejection of the unsupported Worker error mode.

The reviewed `connection-check-v2` tag adds `deploy-connection.yml` and
`check-connection.yml`. Both agents must stay OFF. The deployment uploads
exactly four hashed ES modules, retaining the eight variables, D1 binding,
three secret bindings and enabled invocation/persisted logs. It installs no
dependencies. The older deploy-disabled workflow below predates secret setup
and must not be reused for this diagnostic deployment.

After the separate owner approval, one manual start phase authenticates to
`/internal/connection-probe` with the existing shared Environment secret.
The Worker dispatches one receive phase using its existing GitHub Actions
secret. The receiver leases and completes only the synthetic diagnostic job.
It receives no context and has no model key, Docker step or course callback.
The fixed public identifier is `6d795aa2-9807-4df1-9316-fc872fd439cd`.
Admission is atomic and usable once across all days, including after failure.
The probe creates one diagnostic row, with zero model calls. Job rows do not impose a daily task quota.
Do not delete or reset its row to obtain another attempt.

Only read-only status polling repeats. Each dispatch, lease and completion
POST is sent once. Failure or an uncertain outcome needs owner review.
Successful receipt requires `probe_completed`, the matching receiver run ID
and successful GitHub run results. It does not complete the course challenge.

### Historical deployment workflow

The separate manual `deploy-disabled.yml` workflow accepts only the
`deploy-disabled-v1` tag and uses Environment `mega-s01e05-deploy`.
Its `CLOUDFLARE_DEPLOY_TOKEN` should have short-lived Editor access to this
single Worker. It has no model key and performs one fixed script upload after
checking that agents are disabled. It preserves existing plain-text/D1
bindings, keeps logs enabled, and verifies the public health and manifest.
A failed or uncertain upload is never retried automatically.

The manual `check-gemini.yml` workflow accepts only `gemini-check-v1` in the
model Environment, while live execution remains false. It sends the two
reviewed synthetic bodies in `requests/` to fixed Gemini models, at most once
each, and executes the generated test in the existing isolated Docker runner.
It never receives the deployment token, private course source, or reply URL.
Public Worker checks are GET only; the public and authenticated agent paths
are still disabled. A successful check is not a completed live integration.

## Local verification

Node 24: `npm test` (built-in node:test; no package install required).
Real regression measurement additionally needs Docker and the trusted
Dockerfile.test toolchain. Mocked process tests do not prove container execution.

## Secrets and variables

GitHub Environment `mega-s01e05`: GEMINI_API_KEY and RUNNER_SHARED_KEY.
Environment variables: AGENT_ORIGIN, LIVE_EXECUTION_ENABLED, PULSE_MODEL,
TEST_MODEL. Models are explicit configuration, never an automatic paid fallback.

Cloudflare Worker secrets: PING_KEY, GITHUB_ACTIONS_TOKEN, RUNNER_SHARED_KEY.
OWNER_CODE is a Worker variable, intentionally returned in the ownership manifest.
The shared key must match both services. It never appears in dispatch inputs.
The GitHub token has only Actions write on this dedicated repository.

## Job state and failure policy

Signed ingress atomically reserves the unique webhook ID in D1.
Only a random job ID is sent to workflow_dispatch. The authenticated runner
leases the private context once; the reply token remains in the inbox.
The controller generates at most one model call and sends its validated result
to the Worker. Only the Worker may POST to the original signed reply URL.
No tracker write API exists. Unknown/uncertain outcomes are never retried
automatically; owner review is required. HTTP 202 is receipt, not task acceptance.

The temporary test container has no network or credentials. It receives only
read-only application files and the generated test. Syntax/import errors do
not count as assertion regression evidence. Application fixtures are immutable.
Its trusted controller owns the report directory; application/test workers are
demoted to UID/GID 65532 and cannot replace that file. The reported assertion
is execution evidence, not a proof that arbitrary generated code tests the
right behavior. The synthetic host self-test checks direct report forgery;
the course still evaluates the submitted test's correctness.

## Hosting review requirements

Before deployment review the exact source export, private context, model IDs,
Environment policy (approved-v1 tag only), cost controls and callback timing.
This code is not a claim that any particular account offers free runtime or
that an unspecified reviewer deadline is met. Do not enable public PR workflows
or give forks access to the Environment. Reviewers on every job would prevent
unattended operation; authorization must be resolved before enabling live jobs.
