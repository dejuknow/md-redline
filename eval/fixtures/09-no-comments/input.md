# Deployment Guide

## Prerequisites

- Node.js 20 or later
- Docker and Docker Compose
- AWS CLI configured with appropriate credentials

## Local Development

1. Clone the repository
2. Run `npm install` to install dependencies
3. Copy `.env.example` to `.env` and fill in the required values
4. Run `npm run dev` to start the development server

## Staging Deployment

Staging deployments are triggered automatically when a PR is merged to the `develop` branch. The CI pipeline builds a Docker image, pushes it to ECR, and updates the ECS service.

## Production Deployment

Production deployments require manual approval. After the staging environment is verified:

1. Create a release tag (e.g., `v1.2.3`)
2. The CI pipeline builds and pushes the production image
3. A deployment approval is requested in Slack
4. Once approved, the ECS service is updated with a rolling deployment

## Rollback

To rollback, redeploy the previous task definition revision:

```bash
aws ecs update-service --cluster prod --service api --task-definition api:PREVIOUS_REVISION
```
