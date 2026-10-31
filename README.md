# Signed agent runtime

Generic signed-webhook transport and bounded model agents. This directory
contains no application source, fixtures, private plans or credentials.
Those arrive through a private authenticated job channel at runtime.

Deployment is disabled by default. Both Worker AUTONOMOUS_REPLIES_ENABLED
and GitHub Environment LIVE_EXECUTION_ENABLED require explicit owner approval.
Do not use a repository secret instead of the selected Environment.

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
