# Smart-routing threat model

## Assets and trust boundaries

- The human-owned Buyer Runtime policy and per-call/session/hour/day budgets are authoritative.
- `/v1/quotes` is the authoritative request-specific maximum source used for comparison; the live
  402 and Buyer Runtime validation remain final before signing.
- Model descriptors, quality priors, health snapshots, prompts, and adapter configuration are
  untrusted routing inputs. They possess no signing authority.
- The routing decision and receipt association contain metadata only; the verified server receipt
  remains the payment proof.

## Threats and controls

| Threat                                                                    | Control                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Prompt injects an origin, recipient, maximum, model, or retry instruction | Prompt text reaches classification only; authority fields come from constructor policy and quote port |
| Disabled/incompatible model is selected                                   | Deterministic hard filters run before quotes and ranker                                               |
| Stale health hides an outage or promotes a route                          | Fresh unavailable excludes; stale snapshots score as unknown                                          |
| Cheap route quote is mixed with a different catalog                       | Every candidate is quoted with an explicit model and catalog drift fails closed                       |
| Paid challenge drifts from the selected quote                             | SDK forwards only the selected signed quote token on both challenge and paid requests                 |
| Ranker causes overspend                                                   | Integer atomic maxima; routes above local cap are excluded; Buyer Runtime revalidates live 402        |
| Candidate fallback repeats an ambiguous paid call                         | Route list is advisory, `fallbackAuthorized=false`, and the adapter performs one explicit call        |
| Prompt/completion leaks through explanation                               | Explanation contains model/task/profile/count/version only                                            |
| Malicious quote service lies                                              | It can affect selection but cannot authorize payment; live 402 and Buyer Runtime policy remain final  |
| Candidate explosion causes quote fan-out abuse                            | Policy limit is 1–16; SDK defaults to at most eight                                                   |

## Residual risks

- Operator quality priors can be poor or biased. A provider-backed held-out benchmark is still open.
- A quote may change between selection and the live 402. Buyer Runtime rejects an amount over its
  immutable cap; the paid request may fail rather than silently widen.
- Routing evidence is associated with the durable server receipt in the SDK result, but it is not a
  separately signed receipt field. Product UX qualification remains open before publication.
