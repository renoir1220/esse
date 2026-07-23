# Community and commercial editions

The public repository builds **Esse Community**. Its desktop version follows the public release line (currently `0.3.2`), opens directly into the workspace, and keeps Provider configuration visible in the original settings page.

The commercial product is maintained in a separate private downstream repository. It merges this repository as `upstream`, keeps its own `product.json`, package version, onboarding, and managed-service code, and starts its independent release line at `1.0.0`. Commercial tags never determine the Community version, and Community tags never determine the commercial version.

Shared fixes should land here first whenever they do not expose private service details. The private repository then merges the public branch and resolves only its edition overlay. Managed endpoints, credential policy, billing, entitlements, and commercial onboarding belong only in the private repository.

The two desktop identities must remain distinct so both editions can be installed on one machine:

| Identity | Community | Commercial |
| --- | --- | --- |
| Display name | Esse Community | Esse |
| Windows app/data identity | `esse-community-app` / `esse-community` | private product profile |
| macOS bundle ID | `com.renoir.esse.community` | private product profile |
| Version line | public Esse version | independent, starting at `1.0.0` |

Both repositories run the same test suite and package on Windows x64, macOS arm64, and macOS x64. Product-specific paths and installer names must be read from `sidecars/agent/product.json`, not duplicated in build scripts.
