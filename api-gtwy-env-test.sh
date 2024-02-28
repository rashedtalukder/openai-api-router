export API_GATEWAY_CONFIG_FILE="./api-router-config.json"
export API_GATEWAY_NAME="Gateway-Instance-01"
export API_GATEWAY_PORT=8000
export API_GATEWAY_ENV="dev"
export API_GATEWAY_LOG_LEVEL="info"

# API Gateway Key
export API_GATEWAY_KEY="abcxyz"

# Metrics collection env variables

# Collect metrics hourly
export API_GATEWAY_METRICS_CINTERVAL=60

# Store metrics for the past one week (24 * 7)
export API_GATEWAY_METRICS_CHISTORY=168

# (Optional) Set this value to Azure Application Insights resource connection string
export APPLICATIONINSIGHTS_CONNECTION_STRING=""

# (Optional) Global setting - Use cached retrieval?
export API_GATEWAY_USE_CACHE="true"

# AI Application that exposes vectorization model
export API_GATEWAY_VECTOR_AIAPP="vectorizedata"

# Search engine - only pgvector is supported!
export API_GATEWAY_SRCH_ENGINE="Postgresql/pgvector"

# Vector DB host, port, name, uname and user pwd
export VECTOR_DB_NAME="aoaisvc"
export VECTOR_DB_HOST="gr-apig-dev-pg.postgres.database.azure.com"
export VECTOR_DB_USER="gradmin"
export VECTOR_DB_UPWD="Gbb-2024"
export VECTOR_DB_PORT="5432"
