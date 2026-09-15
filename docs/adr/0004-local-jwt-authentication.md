# 4. Local credentials issue HS256 JWTs

Accepted.

## Context

Every endpoint has to be authenticated, and the service has to run locally with
no setup beyond `docker compose up`. Those pull in opposite directions: a real
deployment would use the organisation's identity provider, but requiring one to
start the service would make it unrunnable for a reviewer.

## Decision

A `users` table with bcrypt password hashes, and a token endpoint that issues
HS256 JWTs. Three roles: admin, client, viewer.

The JWT guard is registered globally, so routes are authenticated by default
and have to opt out with `@Public()`. Forgetting the decorator fails closed.

## Consequences

The service runs with nothing but Docker, and the seeded users make the API
immediately usable.

This is not what would ship. A real deployment replaces the users table with an
identity provider, points `JwtStrategy` at its JWKS and moves to RS256 so the
service verifies without holding a signing secret. The seams are all inside
`AuthModule`; nothing outside it knows where identity comes from.

Also missing, deliberately: refresh tokens, token revocation, per-program
authorisation, and rate limiting on the token endpoint. Each belongs to the
identity provider or the gateway rather than here.
