# Railway deployment

## Current account status

The Railway account is connected to GitHub, but the workspace trial has ended.
Railway currently blocks new projects, new services, and deployments until the
workspace is upgraded to a paid plan.

## Repository runtime

The repository is ready to run as one Node.js service:

- Start command: `npm start`
- Bind address: `0.0.0.0`
- Port: Railway-provided `PORT`
- Health check: `GET /health`
- Static site root: `site/`
- payOS API routes: `/api/payos/*`

`railway.json` stores the start command, health check, and restart policy as
code so they are applied consistently to future deployments.

## One-time Railway setup

After upgrading the Railway workspace:

1. Create a project from the GitHub repository
   `nguyenthanhdat070705/Champions---SOHO`.
2. Select the `main` branch as the service source.
3. Confirm that GitHub autodeploy is enabled.
4. Generate a Railway public domain for the service.
5. Add the variables from `.env.example` in the service Variables tab. Do not
   commit real credentials to GitHub.
6. Set `PAYOS_RETURN_URL`, `PAYOS_CANCEL_URL`, and `PAYOS_WEBHOOK_URL` using the
   Railway public domain.
7. Configure `PAYOS_WEBHOOK_FORWARD_URL` to the durable order service before
   accepting real payments.
8. Register the deployed webhook with `npm run payos:confirm-webhook` from a
   trusted environment containing the payOS credentials.

## Normal delivery flow

```text
Local code -> tests -> git commit -> push origin main
           -> Railway GitHub autodeploy -> /health passes -> production active
```

Railway should be configured to wait for GitHub CI before deploying after a CI
workflow is added. Until then, every push to `main` will trigger a deployment.

