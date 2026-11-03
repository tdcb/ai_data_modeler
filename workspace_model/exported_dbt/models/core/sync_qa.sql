-- dbt Model: sync_qa
-- Logical Entity: Sync Qa | Subject Area: Core
{{
  config(
    materialized='table',
    unique_key='QA_ID',
    schema='core',
    tags=['core', 'mart']
  )
}}

WITH base_sync_qa AS (
    SELECT *
    FROM {{ source('core', 'sync_qa') }}
),

final AS (
    SELECT
        CAST(QA_ID AS NUMBER(38,0)) AS QA_ID, -- Qa Id
        CAST(QA_LABEL AS VARCHAR(80)) AS QA_LABEL -- Qa Label
    FROM base_sync_qa
)

SELECT * FROM final
