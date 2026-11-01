# Signed agent runtime

Generic signed-webhook transport and bounded model agents. This directory
contains no application source, fixtures, private plans or credentials.
Those arrive through a private authenticated job channel at runtime.

Deployment is disabled by default. Both Worker AUTONOMOUS_REPLIES_ENABLED
and GitHub Environment LIVE_EXECUTION_ENABLED require explicit owner approval.
Do not use a repository secret instead of the selected Environment.

## One-use connection check

The reviewed `connection-check-v1` tag adds `deploy-connection.yml` and
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
The fixed public identifier is `92d4685c-7e36-4be4-9cd7-a5915146537a`.
Admission is atomic and usable once across all days, including after failure.
The probe consumes one existing daily job slot, with zero model calls.
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

Signed ingress atomically reserves the daily budget and webhook ID in D1.
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
