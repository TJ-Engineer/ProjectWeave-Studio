FROM node:24-alpine
WORKDIR /opt/openrm
COPY --chown=node:node . .
USER node
ENTRYPOINT ["node", "scripts/bootstrap-openrm-self-project.mjs", "--json"]
