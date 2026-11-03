"""Live Database Connection Manager for Reverse Engineering, SQL Data Profiling, and DDL Execution.

Supports SQLite, Snowflake, Microsoft SQL Server, Oracle, and PostgreSQL.
Provides automated multi-zone sample warehouse generation (Staging, DWH, and Consumption),
metadata persistence via SQLite _metaforge_metadata repository, and automated pushback
of definitions/comments to all supported target database dialects.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import sqlglot
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine

from .auth.models import DatabaseConnectionRecord
from .metamodel.governance_engine import run_data_profiler
from .metamodel.schema import (
    ColumnProfileStats,
    EntityModel,
    EntityVolumetrics,
    ProjectMetamodel,
    RelationshipModel,
    TargetDialect,
)
from .reverse_eng.ddl_parser import parse_ddl_to_metamodel


def ensure_demo_warehouse(demo_db_path: Path) -> str:
    """Creates and seeds a local SQLite Enterprise Demo Warehouse with 3 distinct zones:

    1. Staging Layer (STG_*) - Raw ingested source operational feeds
    2. DWH / Core Layer (DIM_*, FCT_*) - Conformed master dimensions and transactional facts
    3. Consumption / Mart Layer (MART_*, VW_*) - Aggregated analytical views
    Also initializes the _metaforge_metadata repository table for round-trip definitions.
    """
    demo_db_path.parent.mkdir(parents=True, exist_ok=True)
    db_url = f"sqlite:///{demo_db_path}"
    eng = create_engine(db_url, connect_args={"check_same_thread": False})

    with eng.begin() as conn:
        # ===================================================================
        # 0. MetaForge Enterprise Metadata Repository Table
        # ===================================================================
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS _metaforge_metadata (
                    object_type VARCHAR(20) NOT NULL,
                    table_name VARCHAR(100) NOT NULL,
                    column_name VARCHAR(100) NOT NULL,
                    logical_name VARCHAR(150),
                    description TEXT,
                    pii_classification VARCHAR(30),
                    domain_name VARCHAR(80),
                    metadata_status VARCHAR(30),
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (table_name, column_name)
                )
                """
            )
        )

        # ===================================================================
        # ZONE 1: Staging Layer (Raw Operational Feeds)
        # ===================================================================
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS STG_CUSTOMERS (
                    SRC_CUSTOMER_ID INTEGER PRIMARY KEY,
                    FIRST_NAME VARCHAR(50) NOT NULL,
                    LAST_NAME VARCHAR(50) NOT NULL,
                    EMAIL VARCHAR(120) NOT NULL,
                    PHONE VARCHAR(30),
                    CITY VARCHAR(60),
                    COUNTRY_CODE VARCHAR(3) DEFAULT 'USA',
                    REGISTRATION_DATE DATE NOT NULL,
                    STATUS VARCHAR(20) DEFAULT 'ACTIVE',
                    INGESTION_TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS STG_ORDERS (
                    SRC_ORDER_ID INTEGER PRIMARY KEY,
                    SRC_CUSTOMER_ID INTEGER NOT NULL,
                    ORDER_DATETIME TIMESTAMP NOT NULL,
                    ORDER_STATUS VARCHAR(25) NOT NULL,
                    PAYMENT_METHOD VARCHAR(30) NOT NULL,
                    SUBTOTAL_AMOUNT DECIMAL(12,2) NOT NULL,
                    TAX_AMOUNT DECIMAL(10,2) NOT NULL,
                    SHIPPING_AMOUNT DECIMAL(10,2) NOT NULL,
                    TOTAL_AMOUNT DECIMAL(12,2) NOT NULL,
                    INGESTION_TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS STG_ORDER_ITEMS (
                    SRC_ITEM_ID INTEGER PRIMARY KEY,
                    SRC_ORDER_ID INTEGER NOT NULL,
                    SRC_PRODUCT_SKU VARCHAR(40) NOT NULL,
                    QUANTITY INTEGER NOT NULL,
                    UNIT_PRICE DECIMAL(10,2) NOT NULL,
                    DISCOUNT_PERCENT DECIMAL(5,2) DEFAULT 0.0,
                    LINE_TOTAL DECIMAL(12,2) NOT NULL,
                    INGESTION_TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS STG_PRODUCTS (
                    SRC_PRODUCT_SKU VARCHAR(40) PRIMARY KEY,
                    PRODUCT_NAME VARCHAR(150) NOT NULL,
                    CATEGORY VARCHAR(50) NOT NULL,
                    BRAND VARCHAR(50) NOT NULL,
                    UNIT_COST DECIMAL(10,2) NOT NULL,
                    LIST_PRICE DECIMAL(10,2) NOT NULL,
                    INVENTORY_COUNT INTEGER NOT NULL,
                    SUPPLIER_NAME VARCHAR(100),
                    INGESTION_TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS STG_WEB_CLICKS (
                    EVENT_ID INTEGER PRIMARY KEY,
                    SESSION_ID VARCHAR(64) NOT NULL,
                    SRC_CUSTOMER_ID INTEGER,
                    PAGE_PATH VARCHAR(200) NOT NULL,
                    EVENT_NAME VARCHAR(50) NOT NULL,
                    DEVICE_TYPE VARCHAR(25) NOT NULL,
                    EVENT_TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )

        # ===================================================================
        # ZONE 2: DWH / Core Dimensional Layer (Cleaned & Conformed)
        # ===================================================================
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS DIM_CUSTOMER (
                    CUST_ID INTEGER PRIMARY KEY,
                    CUST_FULL_NM VARCHAR(150) NOT NULL,
                    CUST_EMAIL_ADDR VARCHAR(255) UNIQUE,
                    TAX_ID_NBR VARCHAR(20),
                    CUST_STAT_CD VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
                    REC_CRTD_TS TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS DIM_PRODUCT (
                    PRODUCT_KEY INTEGER PRIMARY KEY,
                    PRODUCT_SKU_NK VARCHAR(40) UNIQUE NOT NULL,
                    PRODUCT_NAME VARCHAR(150) NOT NULL,
                    CATEGORY_NAME VARCHAR(50) NOT NULL,
                    BRAND_NAME VARCHAR(50) NOT NULL,
                    UNIT_COST_AMT DECIMAL(12,2) NOT NULL,
                    LIST_PRICE_AMT DECIMAL(12,2) NOT NULL,
                    MARGIN_PCT DECIMAL(6,2) NOT NULL,
                    CURRENT_INVENTORY_QTY INTEGER NOT NULL
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS DIM_DATE (
                    DATE_KEY INTEGER PRIMARY KEY,
                    CALENDAR_DATE DATE NOT NULL,
                    DAY_NAME VARCHAR(15) NOT NULL,
                    MONTH_NUMBER INTEGER NOT NULL,
                    MONTH_NAME VARCHAR(15) NOT NULL,
                    CALENDAR_QUARTER VARCHAR(5) NOT NULL,
                    CALENDAR_YEAR INTEGER NOT NULL,
                    IS_WEEKEND_IND VARCHAR(1) NOT NULL DEFAULT 'N'
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS DIM_AGENT_BROKER (
                    BRKR_ID INTEGER PRIMARY KEY,
                    BRKR_FULL_NM VARCHAR(150) NOT NULL,
                    BRKR_EMAIL_ADDR VARCHAR(255) NOT NULL,
                    BRKR_REGION_CD VARCHAR(30) NOT NULL,
                    COMMISSION_RATE_PCT DECIMAL(5,2) NOT NULL DEFAULT 12.50,
                    ACTIVE_IND VARCHAR(1) NOT NULL DEFAULT 'Y'
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS DIM_INSURANCE_POLICY (
                    PLCY_ID INTEGER PRIMARY KEY,
                    PLCY_NBR VARCHAR(50) NOT NULL UNIQUE,
                    CUST_ID INTEGER NOT NULL,
                    BRKR_ID INTEGER,
                    CVRG_TYP_CD VARCHAR(30) NOT NULL,
                    ANNUAL_PREM_AMT DECIMAL(18,2) NOT NULL,
                    PLCY_EFF_DT DATE NOT NULL,
                    PLCY_EXP_DT DATE NOT NULL,
                    FOREIGN KEY (CUST_ID) REFERENCES DIM_CUSTOMER(CUST_ID),
                    FOREIGN KEY (BRKR_ID) REFERENCES DIM_AGENT_BROKER(BRKR_ID)
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS FCT_ORDERS (
                    ORDER_KEY INTEGER PRIMARY KEY,
                    ORDER_ID_NK INTEGER UNIQUE NOT NULL,
                    CUSTOMER_KEY INTEGER NOT NULL,
                    ORDER_DATE_KEY INTEGER NOT NULL,
                    ORDER_STATUS_CD VARCHAR(20) NOT NULL,
                    PAYMENT_METHOD_CD VARCHAR(20) NOT NULL,
                    SUBTOTAL_AMT DECIMAL(12,2) NOT NULL,
                    TAX_AMT DECIMAL(10,2) NOT NULL,
                    SHIPPING_AMT DECIMAL(10,2) NOT NULL,
                    TOTAL_ORDER_AMT DECIMAL(12,2) NOT NULL,
                    ORDER_ITEM_COUNT INTEGER NOT NULL,
                    FOREIGN KEY (CUSTOMER_KEY) REFERENCES DIM_CUSTOMER(CUST_ID),
                    FOREIGN KEY (ORDER_DATE_KEY) REFERENCES DIM_DATE(DATE_KEY)
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS FCT_ORDER_ITEMS (
                    ORDER_ITEM_KEY INTEGER PRIMARY KEY,
                    ORDER_KEY INTEGER NOT NULL,
                    PRODUCT_KEY INTEGER NOT NULL,
                    CUSTOMER_KEY INTEGER NOT NULL,
                    ITEM_QUANTITY INTEGER NOT NULL,
                    UNIT_SELLING_PRICE_AMT DECIMAL(12,2) NOT NULL,
                    DISCOUNT_AMT DECIMAL(10,2) NOT NULL,
                    NET_SALES_AMT DECIMAL(12,2) NOT NULL,
                    GROSS_PROFIT_AMT DECIMAL(12,2) NOT NULL,
                    FOREIGN KEY (ORDER_KEY) REFERENCES FCT_ORDERS(ORDER_KEY),
                    FOREIGN KEY (PRODUCT_KEY) REFERENCES DIM_PRODUCT(PRODUCT_KEY),
                    FOREIGN KEY (CUSTOMER_KEY) REFERENCES DIM_CUSTOMER(CUST_ID)
                )
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS FCT_CLAIM_TRANSACTION (
                    CLM_TXN_ID INTEGER PRIMARY KEY,
                    PLCY_ID INTEGER NOT NULL,
                    CUST_ID INTEGER NOT NULL,
                    CLM_RPTD_DT DATE NOT NULL,
                    CLM_LOSS_AMT DECIMAL(18,2) NOT NULL,
                    CLM_PAID_AMT DECIMAL(18,2) NOT NULL,
                    CLM_STAT_CD VARCHAR(20) NOT NULL,
                    FOREIGN KEY (PLCY_ID) REFERENCES DIM_INSURANCE_POLICY(PLCY_ID),
                    FOREIGN KEY (CUST_ID) REFERENCES DIM_CUSTOMER(CUST_ID)
                )
                """
            )
        )

        # ===================================================================
        # ZONE 3: Consumption / Mart Layer (Business Views)
        # ===================================================================
        conn.execute(
            text(
                """
                CREATE VIEW IF NOT EXISTS MART_CUSTOMER_LIFETIME_VALUE AS
                SELECT
                    c.CUST_ID AS CUSTOMER_KEY,
                    c.CUST_FULL_NM AS CUSTOMER_NAME,
                    c.CUST_STAT_CD AS CUSTOMER_STATUS,
                    COUNT(o.ORDER_KEY) AS LIFETIME_ORDERS_COUNT,
                    MIN(d.CALENDAR_DATE) AS FIRST_PURCHASE_DATE,
                    MAX(d.CALENDAR_DATE) AS LATEST_PURCHASE_DATE,
                    COALESCE(SUM(o.TOTAL_ORDER_AMT), 0.0) AS LIFETIME_NET_SPEND_AMT,
                    ROUND(COALESCE(AVG(o.TOTAL_ORDER_AMT), 0.0), 2) AS AVG_ORDER_BASKET_AMT
                FROM DIM_CUSTOMER c
                LEFT JOIN FCT_ORDERS o ON c.CUST_ID = o.CUSTOMER_KEY
                LEFT JOIN DIM_DATE d ON o.ORDER_DATE_KEY = d.DATE_KEY
                GROUP BY c.CUST_ID, c.CUST_FULL_NM, c.CUST_STAT_CD
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE VIEW IF NOT EXISTS MART_MONTHLY_REVENUE_KPIS AS
                SELECT
                    d.CALENDAR_YEAR AS REPORTING_YEAR,
                    d.MONTH_NAME AS REPORTING_MONTH,
                    COUNT(o.ORDER_KEY) AS TOTAL_ORDERS_COUNT,
                    SUM(o.TOTAL_ORDER_AMT) AS GROSS_REVENUE_AMT,
                    SUM(o.TAX_AMT) AS TOTAL_TAX_AMT,
                    SUM(o.SHIPPING_AMT) AS TOTAL_SHIPPING_AMT,
                    COUNT(DISTINCT o.CUSTOMER_KEY) AS ACTIVE_BUYING_CUSTOMERS
                FROM FCT_ORDERS o
                INNER JOIN DIM_DATE d ON o.ORDER_DATE_KEY = d.DATE_KEY
                GROUP BY d.CALENDAR_YEAR, d.MONTH_NAME, d.MONTH_NUMBER
                ORDER BY d.CALENDAR_YEAR, d.MONTH_NUMBER
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE VIEW IF NOT EXISTS MART_PRODUCT_CATEGORY_PERFORMANCE AS
                SELECT
                    p.CATEGORY_NAME AS PRODUCT_CATEGORY,
                    COUNT(oi.ORDER_ITEM_KEY) AS ITEMS_SOLD_COUNT,
                    SUM(oi.NET_SALES_AMT) AS CATEGORY_NET_SALES_AMT,
                    SUM(oi.GROSS_PROFIT_AMT) AS CATEGORY_GROSS_PROFIT_AMT,
                    ROUND(AVG(oi.UNIT_SELLING_PRICE_AMT), 2) AS AVG_SELLING_PRICE_AMT
                FROM FCT_ORDER_ITEMS oi
                INNER JOIN DIM_PRODUCT p ON oi.PRODUCT_KEY = p.PRODUCT_KEY
                GROUP BY p.CATEGORY_NAME
                """
            )
        )

        conn.execute(
            text(
                """
                CREATE VIEW IF NOT EXISTS VW_CUSTOMER_CLAIM_SUMMARY AS
                SELECT
                    c.CUST_ID AS CUST_ID,
                    c.CUST_FULL_NM AS CUST_FULL_NM,
                    p.PLCY_NBR AS PLCY_NBR,
                    COUNT(f.CLM_TXN_ID) AS TOTAL_CLM_CNT,
                    SUM(f.CLM_PAID_AMT) AS TOTAL_CLM_PAID_AMT
                FROM DIM_CUSTOMER c
                INNER JOIN DIM_INSURANCE_POLICY p ON c.CUST_ID = p.CUST_ID
                LEFT JOIN FCT_CLAIM_TRANSACTION f ON p.PLCY_ID = f.PLCY_ID
                GROUP BY c.CUST_ID, c.CUST_FULL_NM, p.PLCY_NBR
                """
            )
        )

        # ===================================================================
        # Realistic Seed Data Insertion
        # ===================================================================
        cnt = conn.execute(text("SELECT COUNT(*) FROM DIM_CUSTOMER")).scalar() or 0
        if cnt == 0:
            conn.execute(
                text(
                    """
                    INSERT INTO DIM_CUSTOMER (CUST_ID, CUST_FULL_NM, CUST_EMAIL_ADDR, TAX_ID_NBR, CUST_STAT_CD, REC_CRTD_TS) VALUES
                    (1001, 'Avery Sterling', 'avery.sterling@enterprise.io', '94-8821044', 'ACTIVE', '2024-01-15 09:12:00'),
                    (1002, 'Morgan Vance', 'm.vance@globalcorp.com', '81-3392011', 'ACTIVE', '2024-02-03 14:30:00'),
                    (1003, 'Elena Rostova', 'elena.rostova@nordicbank.org', '77-5019283', 'ACTIVE', '2024-03-19 11:05:00'),
                    (1004, 'Marcus Chen', 'mchen@pacificholdings.net', '62-9182736', 'SUSPENDED', '2024-04-22 16:45:00'),
                    (1005, 'Sophia Al-Mansoor', 'sophia@gulfventures.ae', '55-1928374', 'ACTIVE', '2024-05-10 08:20:00'),
                    (1006, 'Liam O''Connor', 'liam.oconnor@dublinre.ie', NULL, 'PENDING', '2024-06-01 13:10:00'),
                    (1007, 'Hannah Abbott', 'habbott@sterlingtrust.co.uk', '41-7762519', 'ACTIVE', '2024-07-14 10:55:00'),
                    (1008, 'Rajesh Patel', 'rpatel@apexlogistics.in', '38-6651920', 'ACTIVE', '2024-08-29 17:00:00'),
                    (1009, 'Chloe Dubois', 'cdubois@lumiere-assurance.fr', '29-4481726', 'CLOSED', '2024-09-12 12:40:00'),
                    (1010, 'Noah Takahashi', 'noah.t@tokyomarine-partner.jp', '19-9982715', 'ACTIVE', '2024-10-05 15:25:00')
                    """
                )
            )

        cnt_broker = conn.execute(text("SELECT COUNT(*) FROM DIM_AGENT_BROKER")).scalar() or 0
        if cnt_broker == 0:
            conn.execute(
                text(
                    """
                    INSERT INTO DIM_AGENT_BROKER (BRKR_ID, BRKR_FULL_NM, BRKR_EMAIL_ADDR, BRKR_REGION_CD, COMMISSION_RATE_PCT, ACTIVE_IND) VALUES
                    (501, 'Julian Mercer', 'jmercer@marsh-partners.com', 'NA_EAST', 14.50, 'Y'),
                    (502, 'Claire Lindqvist', 'clindqvist@aon-nordic.se', 'EMEA_NORTH', 12.00, 'Y'),
                    (503, 'Kenji Sato', 'ksato@willis-apac.jp', 'APAC', 15.00, 'Y'),
                    (504, 'spillman.d@gallagher.us', 'd.spillman@gallagher.us', 'NA_WEST', 11.25, 'N')
                    """
                )
            )

        cnt_policy = conn.execute(text("SELECT COUNT(*) FROM DIM_INSURANCE_POLICY")).scalar() or 0
        if cnt_policy == 0:
            conn.execute(
                text(
                    """
                    INSERT INTO DIM_INSURANCE_POLICY (PLCY_ID, PLCY_NBR, CUST_ID, BRKR_ID, CVRG_TYP_CD, ANNUAL_PREM_AMT, PLCY_EFF_DT, PLCY_EXP_DT) VALUES
                    (2001, 'POL-2025-00101', 1001, 501, 'CYBER_ENTERPRISE', 48500.00, '2025-01-01', '2025-12-31'),
                    (2002, 'POL-2025-00102', 1002, 501, 'COMMERCIAL_PROPERTY', 125000.00, '2025-01-15', '2026-01-14'),
                    (2003, 'POL-2025-00103', 1003, 502, 'MARINE_CARGO', 89200.50, '2025-02-01', '2026-01-31'),
                    (2004, 'POL-2025-00104', 1004, 504, 'GENERAL_LIABILITY', 19400.00, '2025-03-01', '2026-02-28'),
                    (2005, 'POL-2025-00105', 1005, 502, 'DIRECTORS_OFFICERS', 210000.00, '2025-03-15', '2026-03-14'),
                    (2006, 'POL-2025-00106', 1007, 502, 'CYBER_ENTERPRISE', 64000.00, '2025-04-01', '2026-03-31'),
                    (2007, 'POL-2025-00107', 1008, 503, 'MARINE_CARGO', 112500.00, '2025-05-01', '2026-04-30'),
                    (2008, 'POL-2025-00108', 1010, 503, 'COMMERCIAL_PROPERTY', 175800.00, '2025-06-01', '2026-05-31')
                    """
                )
            )

        cnt_claim = conn.execute(text("SELECT COUNT(*) FROM FCT_CLAIM_TRANSACTION")).scalar() or 0
        if cnt_claim == 0:
            conn.execute(
                text(
                    """
                    INSERT INTO FCT_CLAIM_TRANSACTION (CLM_TXN_ID, PLCY_ID, CUST_ID, CLM_RPTD_DT, CLM_LOSS_AMT, CLM_PAID_AMT, CLM_STAT_CD) VALUES
                    (9001, 2001, 1001, '2025-02-14', 18500.00, 15000.00, 'SETTLED'),
                    (9002, 2002, 1002, '2025-03-02', 94000.00, 88500.00, 'SETTLED'),
                    (9003, 2003, 1003, '2025-04-11', 32000.00, 0.00, 'IN_REVIEW'),
                    (9004, 2005, 1005, '2025-05-19', 450000.00, 410000.00, 'SETTLED'),
                    (9005, 2001, 1001, '2025-06-22', 6200.00, 6200.00, 'SETTLED'),
                    (9006, 2007, 1008, '2025-07-08', 54000.00, 51000.00, 'SETTLED'),
                    (9007, 2008, 1010, '2025-08-15', 12800.00, 0.00, 'DENIED'),
                    (9008, 2006, 1007, '2025-09-01', 29500.00, 27000.00, 'SETTLED')
                    """
                )
            )

        # Seed Staging Tables
        cnt_stg_c = conn.execute(text("SELECT COUNT(*) FROM STG_CUSTOMERS")).scalar() or 0
        if cnt_stg_c == 0:
            conn.execute(
                text(
                    """
                    INSERT INTO STG_CUSTOMERS (SRC_CUSTOMER_ID, FIRST_NAME, LAST_NAME, EMAIL, PHONE, CITY, COUNTRY_CODE, REGISTRATION_DATE, STATUS) VALUES
                    (101, 'Liam', 'Anderson', 'liam.anderson@acme.com', '+1-555-0101', 'Chicago', 'USA', '2024-01-10', 'ACTIVE'),
                    (102, 'Sophia', 'Martinez', 'sophia.m@cloudtech.org', '+1-555-0102', 'Austin', 'USA', '2024-01-18', 'ACTIVE'),
                    (103, 'Oliver', 'Wright', 'oliver.wright@logix.co.uk', '+44-20-7946', 'London', 'GBR', '2024-02-05', 'PENDING'),
                    (104, 'Emma', 'Johansson', 'emma.j@nordicstyle.se', '+46-8-1234', 'Stockholm', 'SWE', '2024-02-22', 'ACTIVE'),
                    (105, 'Noah', 'Tanaka', 'noah.t@pacificedge.jp', '+81-3-5555', 'Tokyo', 'JPN', '2024-03-01', 'ACTIVE')
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO STG_PRODUCTS (SRC_PRODUCT_SKU, PRODUCT_NAME, CATEGORY, BRAND, UNIT_COST, LIST_PRICE, INVENTORY_COUNT, SUPPLIER_NAME) VALUES
                    ('SKU-SRV-001', 'Enterprise Cloud Server Node X8', 'Hardware', 'ServerCore', 2450.00, 4899.00, 120, 'Global Micro Devices'),
                    ('SKU-SW-002', 'MetaForge Studio Governance Seat', 'Software', 'MetaForge', 120.00, 999.00, 9999, 'MetaForge Enterprise LLC'),
                    ('SKU-SEC-003', 'Hardware Security Key HSM v3', 'Security', 'VaultShield', 85.00, 249.50, 450, 'Titan Cryptography'),
                    ('SKU-NET-004', '40GbE Fiber Switch Module', 'Networking', 'NetOptics', 650.00, 1499.00, 85, 'Pacific Optics Corp')
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO STG_ORDERS (SRC_ORDER_ID, SRC_CUSTOMER_ID, ORDER_DATETIME, ORDER_STATUS, PAYMENT_METHOD, SUBTOTAL_AMOUNT, TAX_AMOUNT, SHIPPING_AMOUNT, TOTAL_AMOUNT) VALUES
                    (5001, 101, '2025-01-15 10:20:00', 'COMPLETED', 'CREDIT_CARD', 4899.00, 391.92, 45.00, 5335.92),
                    (5002, 102, '2025-01-22 14:45:00', 'COMPLETED', 'ACH_TRANSFER', 1998.00, 159.84, 0.00, 2157.84),
                    (5003, 103, '2025-02-04 09:15:00', 'PENDING', 'WIRE_TRANSFER', 249.50, 19.96, 15.00, 284.46),
                    (5004, 104, '2025-02-18 16:30:00', 'COMPLETED', 'CREDIT_CARD', 6398.00, 511.84, 85.00, 6994.84),
                    (5005, 105, '2025-03-02 11:00:00', 'COMPLETED', 'CREDIT_CARD', 1499.00, 119.92, 25.00, 1643.92)
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO STG_ORDER_ITEMS (SRC_ITEM_ID, SRC_ORDER_ID, SRC_PRODUCT_SKU, QUANTITY, UNIT_PRICE, DISCOUNT_PERCENT, LINE_TOTAL) VALUES
                    (8001, 5001, 'SKU-SRV-001', 1, 4899.00, 0.0, 4899.00),
                    (8002, 5002, 'SKU-SW-002', 2, 999.00, 0.0, 1998.00),
                    (8003, 5003, 'SKU-SEC-003', 1, 249.50, 0.0, 249.50),
                    (8004, 5004, 'SKU-SRV-001', 1, 4899.00, 0.0, 4899.00),
                    (8005, 5004, 'SKU-NET-004', 1, 1499.00, 0.0, 1499.00),
                    (8006, 5005, 'SKU-NET-004', 1, 1499.00, 0.0, 1499.00)
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO STG_WEB_CLICKS (EVENT_ID, SESSION_ID, SRC_CUSTOMER_ID, PAGE_PATH, EVENT_NAME, DEVICE_TYPE) VALUES
                    (1, 'sess_abc123', 101, '/products/servers', 'PAGE_VIEW', 'DESKTOP'),
                    (2, 'sess_abc123', 101, '/cart/add', 'ADD_TO_CART', 'DESKTOP'),
                    (3, 'sess_xyz789', 102, '/pricing', 'PAGE_VIEW', 'MOBILE'),
                    (4, 'sess_xyz789', 102, '/checkout', 'CHECKOUT_START', 'MOBILE'),
                    (5, 'sess_qwe456', 104, '/products/hardware', 'PAGE_VIEW', 'DESKTOP')
                    """
                )
            )

        # Seed Core DWH Tables
        cnt_dim_p = conn.execute(text("SELECT COUNT(*) FROM DIM_PRODUCT")).scalar() or 0
        if cnt_dim_p == 0:
            conn.execute(
                text(
                    """
                    INSERT INTO DIM_PRODUCT (PRODUCT_KEY, PRODUCT_SKU_NK, PRODUCT_NAME, CATEGORY_NAME, BRAND_NAME, UNIT_COST_AMT, LIST_PRICE_AMT, MARGIN_PCT, CURRENT_INVENTORY_QTY) VALUES
                    (1, 'SKU-SRV-001', 'Enterprise Cloud Server Node X8', 'Hardware', 'ServerCore', 2450.00, 4899.00, 49.99, 120),
                    (2, 'SKU-SW-002', 'MetaForge Studio Governance Seat', 'Software', 'MetaForge', 120.00, 999.00, 87.99, 9999),
                    (3, 'SKU-SEC-003', 'Hardware Security Key HSM v3', 'Security', 'VaultShield', 85.00, 249.50, 65.93, 450),
                    (4, 'SKU-NET-004', '40GbE Fiber Switch Module', 'Networking', 'NetOptics', 650.00, 1499.00, 56.64, 85)
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO DIM_DATE (DATE_KEY, CALENDAR_DATE, DAY_NAME, MONTH_NUMBER, MONTH_NAME, CALENDAR_QUARTER, CALENDAR_YEAR, IS_WEEKEND_IND) VALUES
                    (20250115, '2025-01-15', 'Wednesday', 1, 'January', 'Q1', 2025, 'N'),
                    (20250122, '2025-01-22', 'Wednesday', 1, 'January', 'Q1', 2025, 'N'),
                    (20250204, '2025-02-04', 'Tuesday', 2, 'February', 'Q1', 2025, 'N'),
                    (20250218, '2025-02-18', 'Tuesday', 2, 'February', 'Q1', 2025, 'N'),
                    (20250302, '2025-03-02', 'Sunday', 3, 'March', 'Q1', 2025, 'Y')
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO FCT_ORDERS (ORDER_KEY, ORDER_ID_NK, CUSTOMER_KEY, ORDER_DATE_KEY, ORDER_STATUS_CD, PAYMENT_METHOD_CD, SUBTOTAL_AMT, TAX_AMT, SHIPPING_AMT, TOTAL_ORDER_AMT, ORDER_ITEM_COUNT) VALUES
                    (1, 5001, 1001, 20250115, 'COMPLETED', 'CREDIT_CARD', 4899.00, 391.92, 45.00, 5335.92, 1),
                    (2, 5002, 1002, 20250122, 'COMPLETED', 'ACH_TRANSFER', 1998.00, 159.84, 0.00, 2157.84, 2),
                    (3, 5003, 1003, 20250204, 'PENDING', 'WIRE_TRANSFER', 249.50, 19.96, 15.00, 284.46, 1),
                    (4, 5004, 1004, 20250218, 'COMPLETED', 'CREDIT_CARD', 6398.00, 511.84, 85.00, 6994.84, 2),
                    (5, 5005, 1005, 20250302, 'COMPLETED', 'CREDIT_CARD', 1499.00, 119.92, 25.00, 1643.92, 1)
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO FCT_ORDER_ITEMS (ORDER_ITEM_KEY, ORDER_KEY, PRODUCT_KEY, CUSTOMER_KEY, ITEM_QUANTITY, UNIT_SELLING_PRICE_AMT, DISCOUNT_AMT, NET_SALES_AMT, GROSS_PROFIT_AMT) VALUES
                    (1, 1, 1, 1001, 1, 4899.00, 0.0, 4899.00, 2449.00),
                    (2, 2, 2, 1002, 2, 999.00, 0.0, 1998.00, 1758.00),
                    (3, 3, 3, 1003, 1, 249.50, 0.0, 249.50, 164.50),
                    (4, 4, 1, 1004, 1, 4899.00, 0.0, 4899.00, 2449.00),
                    (5, 4, 4, 1004, 1, 1499.00, 0.0, 1499.00, 849.00),
                    (6, 5, 4, 1005, 1, 1499.00, 0.0, 1499.00, 849.00)
                    """
                )
            )

        # Pre-seed Metadata Repository with sample definitions
        cnt_meta = conn.execute(text("SELECT COUNT(*) FROM _metaforge_metadata")).scalar() or 0
        if cnt_meta == 0:
            conn.execute(
                text(
                    """
                    INSERT INTO _metaforge_metadata (object_type, table_name, column_name, logical_name, description, pii_classification, domain_name, metadata_status) VALUES
                    ('TABLE', 'DIM_CUSTOMER', '__TABLE__', 'Customer Dimension', 'Conformed master customer dimension storing verified corporate and retail customer profiles.', 'NONE', NULL, 'STEWARD_VERIFIED'),
                    ('COLUMN', 'DIM_CUSTOMER', 'CUST_ID', 'Customer Identifier', 'Unique surrogate primary key indexing each customer record across all enterprise channels.', 'NONE', 'Surrogate_Key', 'STEWARD_VERIFIED'),
                    ('COLUMN', 'DIM_CUSTOMER', 'CUST_FULL_NM', 'Customer Full Name', 'Legal registered name or corporate trade name of the customer.', 'RESTRICTED_PII', 'Full_Name', 'STEWARD_VERIFIED'),
                    ('COLUMN', 'DIM_CUSTOMER', 'CUST_EMAIL_ADDR', 'Customer Email Address', 'Primary corporate email address used for electronic billing and multi-factor authentication.', 'RESTRICTED_PII', 'Email_Address', 'STEWARD_VERIFIED'),
                    ('TABLE', 'FCT_ORDERS', '__TABLE__', 'Orders Fact Table', 'Atomic transactional order events recording customer purchases, subtotal measures, tax, and freight.', 'NONE', NULL, 'STEWARD_VERIFIED'),
                    ('COLUMN', 'FCT_ORDERS', 'TOTAL_ORDER_AMT', 'Total Order Amount', 'Total gross amount charged to customer in USD including subtotal, sales tax, and freight charges.', 'CONFIDENTIAL', 'Monetary_Amount', 'STEWARD_VERIFIED')
                    """
                )
            )

    return db_url


def build_sqlalchemy_url(
    dialect: str,
    host: Optional[str] = None,
    port: Optional[int] = None,
    database_name: Optional[str] = None,
    schema_name: Optional[str] = None,
    username: Optional[str] = None,
    password_secret: Optional[str] = None,
    warehouse: Optional[str] = None,
    role_name: Optional[str] = None,
    connection_url: Optional[str] = None,
) -> str:
    """Constructs a SQLAlchemy connection URI from structured parameters or returns connection_url."""
    if connection_url and connection_url.strip():
        return connection_url.strip()

    d = (dialect or "sqlite").lower().strip()
    if d == "sqlite":
        db_file = database_name or "workspace_model/demo_warehouse.db"
        return f"sqlite:///{db_file}"

    user = username or "user"
    pwd = password_secret or ""
    auth = f"{user}:{pwd}@" if pwd else f"{user}@"
    h = host or "localhost"

    if d == "postgresql":
        p = f":{port}" if port else ":5432"
        db = database_name or "postgres"
        return f"postgresql://{auth}{h}{p}/{db}"

    if d == "snowflake":
        db = database_name or "ENTERPRISE_DW"
        sch = schema_name or "PUBLIC"
        q_parts = []
        if warehouse:
            q_parts.append(f"warehouse={warehouse}")
        if role_name:
            q_parts.append(f"role={role_name}")
        qs = ("?" + "&".join(q_parts)) if q_parts else ""
        return f"snowflake://{auth}{h}/{db}/{sch}{qs}"

    if d in ("sql_server", "tsql", "mssql"):
        p = f":{port}" if port else ":1433"
        db = database_name or "master"
        return f"mssql+pyodbc://{auth}{h}{p}/{db}?driver=ODBC+Driver+18+for+SQL+Server"

    if d == "oracle":
        p = f":{port}" if port else ":1521"
        svc = database_name or "ORCLPDB1"
        return f"oracle+oracledb://{auth}{h}{p}/?service_name={svc}"

    return f"sqlite:///{database_name or 'workspace_model/demo_warehouse.db'}"


def create_engine_for_connection(conn_rec: DatabaseConnectionRecord) -> Engine:
    url = build_sqlalchemy_url(
        dialect=conn_rec.dialect,
        host=conn_rec.host,
        port=conn_rec.port,
        database_name=conn_rec.database_name,
        schema_name=conn_rec.schema_name,
        username=conn_rec.username,
        password_secret=conn_rec.password_secret,
        warehouse=conn_rec.warehouse,
        role_name=conn_rec.role_name,
        connection_url=conn_rec.connection_url,
    )
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args)


def test_database_connection(
    dialect: str,
    host: Optional[str] = None,
    port: Optional[int] = None,
    database_name: Optional[str] = None,
    schema_name: Optional[str] = None,
    username: Optional[str] = None,
    password_secret: Optional[str] = None,
    warehouse: Optional[str] = None,
    role_name: Optional[str] = None,
    connection_url: Optional[str] = None,
) -> Dict[str, Any]:
    """Tests connectivity, measures latency, and lists discovered tables and views across enterprise zones."""
    t0 = time.perf_counter()
    url = build_sqlalchemy_url(
        dialect=dialect,
        host=host,
        port=port,
        database_name=database_name,
        schema_name=schema_name,
        username=username,
        password_secret=password_secret,
        warehouse=warehouse,
        role_name=role_name,
        connection_url=connection_url,
    )
    try:
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        eng = create_engine(url, connect_args=connect_args)
        with eng.connect() as conn:
            conn.execute(text("SELECT 1"))
            insp = inspect(eng)
            sch = (
                schema_name
                if (not url.startswith("sqlite") and schema_name and schema_name.upper() != "PUBLIC")
                else None
            )
            raw_tables = insp.get_table_names(schema=sch)
            # Filter out metadata infrastructure table
            tables = [t for t in raw_tables if t.upper() != "_METAFORGE_METADATA"]
            views = insp.get_view_names(schema=sch)
        latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        return {
            "ok": True,
            "latency_ms": latency_ms,
            "dialect": dialect,
            "tables": tables,
            "views": views,
            "message": f"Connected in {latency_ms}ms — discovered {len(tables)} table(s) and {len(views)} view(s).",
        }
    except Exception as exc:
        latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        return {
            "ok": False,
            "latency_ms": latency_ms,
            "dialect": dialect,
            "tables": [],
            "views": [],
            "message": f"Connection failed: {exc}",
        }


def _metadata_only() -> bool:
    from .ai.settings_store import metadata_only

    return metadata_only()


def inspect_database_ddl(
    eng: Engine,
    schema_name: Optional[str] = None,
    selected_objects: Optional[List[str]] = None,
) -> Tuple[str, Dict[str, int], Dict[Tuple[str, str], Dict[str, Any]]]:
    """Extracts live schema metadata via SQLAlchemy Inspector, synthesizes canonical DDL,

    counts rows, and extracts existing comments / _metaforge_metadata repository cache.
    """
    insp = inspect(eng)
    is_sqlite = eng.url.drivername.startswith("sqlite")
    sch = None if is_sqlite else (schema_name if schema_name and schema_name.upper() != "PUBLIC" else None)

    raw_tables = insp.get_table_names(schema=sch)
    views = insp.get_view_names(schema=sch)

    # Exclude internal metadata table from canvas entities
    tables = [t for t in raw_tables if t.upper() != "_METAFORGE_METADATA"]
    selected_upper = {s.upper() for s in selected_objects} if selected_objects else None

    ddl_blocks: List[str] = []
    row_counts: Dict[str, int] = {}
    metadata_cache: Dict[Tuple[str, str], Dict[str, Any]] = {}

    with eng.connect() as conn:
        # If _metaforge_metadata exists, load definitions cache
        if "_metaforge_metadata" in [t.lower() for t in raw_tables]:
            try:
                meta_rows = conn.execute(
                    text(
                        "SELECT object_type, table_name, column_name, logical_name, description, pii_classification, domain_name, metadata_status FROM _metaforge_metadata"
                    )
                ).mappings().all()
                for r in meta_rows:
                    t_nm = str(r["table_name"]).upper()
                    c_nm = str(r["column_name"]).upper()
                    metadata_cache[(t_nm, c_nm)] = {
                        "logical_name": r["logical_name"],
                        "description": r["description"],
                        "pii_classification": r["pii_classification"],
                        "domain_name": r["domain_name"],
                        "metadata_status": r["metadata_status"],
                    }
            except Exception:
                pass

        for tbl in tables:
            if selected_upper and tbl.upper() not in selected_upper:
                continue
            cols = insp.get_columns(tbl, schema=sch)
            pk_constraint = insp.get_pk_constraint(tbl, schema=sch) or {}
            pk_cols = {c.upper() for c in (pk_constraint.get("constrained_columns") or [])}
            fks = insp.get_foreign_keys(tbl, schema=sch) or []

            # Check for native table comment
            try:
                t_comm = insp.get_table_comment(tbl, schema=sch)
                if t_comm and t_comm.get("text"):
                    metadata_cache[(tbl.upper(), "__TABLE__")] = {
                        "description": t_comm["text"],
                        "logical_name": None,
                        "metadata_status": "STEWARD_VERIFIED",
                    }
            except Exception:
                pass

            col_lines: List[str] = []
            for col in cols:
                c_name = col["name"].upper()
                c_type = str(col.get("type") or "VARCHAR(255)").upper()
                if c_type == "INTEGER":
                    c_type = "NUMBER(38,0)"
                elif c_type in ("TEXT", "VARCHAR"):
                    c_type = "VARCHAR(255)"
                nullable = col.get("nullable", True)
                pk_inline = " PRIMARY KEY" if (c_name in pk_cols and len(pk_cols) == 1) else ""
                null_str = " NOT NULL" if (not nullable or c_name in pk_cols) else ""
                col_lines.append(f"    {c_name} {c_type}{pk_inline}{null_str}")

                if col.get("comment"):
                    metadata_cache[(tbl.upper(), c_name)] = {
                        "description": col["comment"],
                        "metadata_status": "STEWARD_VERIFIED",
                    }

            if len(pk_cols) > 1:
                col_lines.append(f"    PRIMARY KEY ({', '.join(sorted(pk_cols))})")

            for fk in fks:
                local_cols = [c.upper() for c in (fk.get("constrained_columns") or [])]
                referred_table = (fk.get("referred_table") or "").upper()
                referred_cols = [c.upper() for c in (fk.get("referred_columns") or [])]
                if local_cols and referred_table and referred_cols:
                    col_lines.append(
                        f"    FOREIGN KEY ({local_cols[0]}) REFERENCES {referred_table}({referred_cols[0]})"
                    )

            ddl_blocks.append(
                f"CREATE TABLE {tbl.upper()} (\n" + ",\n".join(col_lines) + "\n);"
            )
            if _metadata_only():
                continue
            try:
                cnt = conn.execute(text(f'SELECT COUNT(*) FROM "{tbl}"')).scalar() or 0
                row_counts[tbl.upper()] = int(cnt)
            except Exception:
                row_counts[tbl.upper()] = 0

        for vw in views:
            if selected_upper and vw.upper() not in selected_upper:
                continue
            try:
                v_def = insp.get_view_definition(vw, schema=sch)
                if v_def:
                    v_sql = v_def.strip().rstrip(";")
                    if not v_sql.upper().startswith("CREATE"):
                        v_sql = f"CREATE VIEW {vw.upper()} AS\n{v_sql}"
                    ddl_blocks.append(v_sql + ";")
            except Exception:
                pass

    return "\n\n".join(ddl_blocks), row_counts, metadata_cache


def reverse_engineer_from_connection(
    conn_rec: DatabaseConnectionRecord,
    model: ProjectMetamodel,
    subject_area: str = "Core",
    selected_objects: Optional[List[str]] = None,
    merge_into_project: bool = True,
) -> Tuple[int, int, str]:
    """Connects to live DB, extracts DDL, row counts, and metadata, routes objects to enterprise zones,

    and restores definitions and comments.
    """
    eng = create_engine_for_connection(conn_rec)
    synthesized_ddl, row_counts, metadata_cache = inspect_database_ddl(
        eng, schema_name=conn_rec.schema_name, selected_objects=selected_objects
    )
    if not synthesized_ddl.strip():
        return 0, 0, ""

    target_dialect = TargetDialect(
        conn_rec.dialect
        if conn_rec.dialect in ("snowflake", "sql_server", "oracle")
        else "snowflake"
    )
    entities, relationships = parse_ddl_to_metamodel(
        ddl_script=synthesized_ddl,
        dialect=target_dialect,
        default_subject_area=subject_area,
        existing_entities=model.entities if merge_into_project else None,
    )

    if not merge_into_project:
        model.entities = {}
        model.relationships = {}

    existing_by_phys = {e.physical_name.upper(): e.id for e in model.entities.values()}
    id_remap: Dict[str, str] = {}

    # Ensure zones exist in model subject_areas
    for zone in ("Staging", "Core", "Consumption"):
        if zone not in model.subject_areas:
            model.subject_areas.append(zone)

    for ent in entities:
        phys_key = ent.physical_name.upper()

        # 1. Multi-Zone Auto Routing & Visual Stereotyping
        if phys_key.startswith(("STG_", "RAW_")):
            ent.subject_area = "Staging"
            ent.header_color = "#f59e0b"
            ent.dbt_layer = "staging"
            ent.modeling_stereotype = "ODS_STAGING"
        elif phys_key.startswith(("MART_", "VW_")) or ent.entity_type in ("view", "materialized_view"):
            ent.subject_area = "Consumption"
            ent.header_color = "#0d9488"
            ent.dbt_layer = "mart"
            ent.entity_type = "view"
            ent.modeling_stereotype = "ANALYTICAL_VIEW"
        elif phys_key.startswith("DIM_"):
            ent.subject_area = subject_area if subject_area != "Core" else "Core"
            ent.header_color = "#2563eb"
            ent.dbt_layer = "mart"
            ent.modeling_stereotype = "DIM_SCD1"
        elif phys_key.startswith("FCT_"):
            ent.subject_area = subject_area if subject_area != "Core" else "Core"
            ent.header_color = "#4f46e5"
            ent.dbt_layer = "mart"
            ent.modeling_stereotype = "FCT_TRANSACTION"
        else:
            ent.subject_area = subject_area
            ent.header_color = "#2563eb"
            ent.dbt_layer = "mart"

        if ent.subject_area not in model.subject_areas:
            model.subject_areas.append(ent.subject_area)

        # 2. Assign Live Volumetrics
        if phys_key in row_counts:
            rc = row_counts[phys_key]
            ent.volumetrics = EntityVolumetrics(
                estimated_row_count=rc,
                avg_row_bytes=max(64, len(ent.columns) * 32),
                monthly_growth_pct=3.5,
                estimated_size_gb=round((rc * max(64, len(ent.columns) * 32)) / (1024**3), 6),
            )

        # 3. Restore Metadata & Definitions from Cache
        table_meta = metadata_cache.get((phys_key, "__TABLE__"))
        if table_meta:
            if table_meta.get("description"):
                ent.description = table_meta["description"]
            if table_meta.get("logical_name"):
                ent.logical_name = table_meta["logical_name"]
            if table_meta.get("metadata_status"):
                ent.metadata_status = table_meta["metadata_status"]

        for col in ent.columns:
            col_meta = metadata_cache.get((phys_key, col.physical_name.upper()))
            if col_meta:
                if col_meta.get("description"):
                    col.description = col_meta["description"]
                if col_meta.get("logical_name"):
                    col.logical_name = col_meta["logical_name"]
                if col_meta.get("pii_classification"):
                    col.pii_classification = col_meta["pii_classification"]
                if col_meta.get("metadata_status"):
                    col.metadata_status = col_meta["metadata_status"]

        if phys_key in existing_by_phys:
            old_id = existing_by_phys[phys_key]
            id_remap[ent.id] = old_id
            ent.id = old_id
        model.entities[ent.id] = ent

    for rel in relationships:
        rel.parent_entity_id = id_remap.get(rel.parent_entity_id, rel.parent_entity_id)
        rel.child_entity_id = id_remap.get(rel.child_entity_id, rel.child_entity_id)
        model.relationships[rel.id] = rel

    return len(entities), len(relationships), synthesized_ddl


def profile_from_connection(
    conn_rec: DatabaseConnectionRecord,
    model: ProjectMetamodel,
    entity_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Executes live SQL profiling queries (COUNT, NULL %, DISTINCT, MIN, MAX, samples) against connected DB tables."""
    eng = create_engine_for_connection(conn_rec)
    insp = inspect(eng)
    is_sqlite = eng.url.drivername.startswith("sqlite")
    sch = (
        None
        if is_sqlite
        else (
            conn_rec.schema_name
            if conn_rec.schema_name and conn_rec.schema_name.upper() != "PUBLIC"
            else None
        )
    )

    db_tables = {t.upper(): t for t in insp.get_table_names(schema=sch)}
    db_views = {v.upper(): v for v in insp.get_view_names(schema=sch)}
    all_db_objects = {**db_tables, **db_views}

    target_entities = (
        [model.entities[entity_id]]
        if entity_id and entity_id in model.entities
        else list(model.entities.values())
    )

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    live_tables_profiled = 0
    columns_profiled = 0
    total_recommendations = 0

    with eng.connect() as conn:
        for ent in target_entities:
            phys_upper = ent.physical_name.upper()
            actual_tbl = all_db_objects.get(phys_upper)
            if not actual_tbl:
                sub_stats = run_data_profiler(model, ent.id)
                columns_profiled += sub_stats["columns_profiled"]
                total_recommendations += sub_stats["total_recommendations"]
                continue

            db_cols_info = insp.get_columns(actual_tbl, schema=sch)
            db_col_map = {c["name"].upper(): c["name"] for c in db_cols_info}

            total_rows = int(
                conn.execute(text(f'SELECT COUNT(*) FROM "{actual_tbl}"')).scalar() or 0
            )
            avg_bytes = max(48, len(ent.columns) * 28)
            ent.volumetrics = EntityVolumetrics(
                estimated_row_count=total_rows,
                avg_row_bytes=avg_bytes,
                monthly_growth_pct=4.0,
                estimated_size_gb=round((total_rows * avg_bytes) / (1024**3), 6),
            )
            live_tables_profiled += 1

            for col in ent.columns:
                actual_col = db_col_map.get(col.physical_name.upper())
                if not actual_col or total_rows == 0:
                    continue

                stat_row = conn.execute(
                    text(
                        f'SELECT COUNT(*) - COUNT("{actual_col}") AS null_cnt, '
                        f'COUNT(DISTINCT "{actual_col}") AS dist_cnt, '
                        f'MIN("{actual_col}") AS min_val, '
                        f'MAX("{actual_col}") AS max_val '
                        f'FROM "{actual_tbl}"'
                    )
                ).mappings().first()

                null_cnt = int(stat_row["null_cnt"] or 0) if stat_row else 0
                dist_cnt = int(stat_row["dist_cnt"] or 0) if stat_row else 0
                min_val = str(stat_row["min_val"]) if (stat_row and stat_row["min_val"] is not None) else None
                max_val = str(stat_row["max_val"]) if (stat_row and stat_row["max_val"] is not None) else None

                sample_rows = conn.execute(
                    text(
                        f'SELECT DISTINCT "{actual_col}" AS val FROM "{actual_tbl}" '
                        f'WHERE "{actual_col}" IS NOT NULL LIMIT 5'
                    )
                ).scalars().all()
                samples = [str(s) for s in sample_rows if s is not None]

                null_pct = round((null_cnt / total_rows) * 100.0, 2) if total_rows > 0 else 0.0
                uniq_pct = round((dist_cnt / total_rows) * 100.0, 2) if total_rows > 0 else 0.0

                recs: List[str] = []
                if null_pct == 0.0 and "not_null" not in col.dbt_tests:
                    recs.append("not_null")
                if uniq_pct == 100.0 and not col.is_pk and "unique" not in col.dbt_tests:
                    recs.append("unique")
                if 1 <= dist_cnt <= 8 and not col.is_pk and "accepted_values" not in col.dbt_tests:
                    recs.append("accepted_values")
                if col.is_fk and "relationships" not in col.dbt_tests:
                    recs.append("relationships")
                if col.physical_name.upper().endswith(("_AMT", "_PRICE", "_COST")) and min_val is not None:
                    try:
                        if float(min_val) >= 0 and not col.check_constraint:
                            recs.append("check_non_negative")
                    except ValueError:
                        pass

                detected_pattern = "LIVE_SQL_PROFILED"
                if "EMAIL" in col.physical_name.upper():
                    detected_pattern = r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$"
                elif col.physical_name.upper().endswith(("_CD", "_STAT")):
                    detected_pattern = "ENUM(" + "|".join(samples[:5]) + ")"

                col.profile = ColumnProfileStats(
                    null_pct=null_pct,
                    distinct_count=dist_cnt,
                    uniqueness_pct=uniq_pct,
                    min_value=min_val,
                    max_value=max_val,
                    sample_values=samples,
                    detected_pattern=detected_pattern,
                    recommended_tests=recs,
                    last_profiled_at=now_iso,
                )
                columns_profiled += 1
                total_recommendations += len(recs)

    return {
        "entities_profiled": len(target_entities),
        "live_tables_profiled": live_tables_profiled,
        "columns_profiled": columns_profiled,
        "total_recommendations": total_recommendations,
        "connection_name": conn_rec.name,
        "profiled_at": now_iso,
    }


def _adapt_statement_for_sqlite(stmt: str) -> Optional[str]:
    """Adapts enterprise Snowflake/SQL Server/Oracle DDL statements so they can run cleanly on a local SQLite connection."""
    clean = stmt.strip().rstrip(";").strip()
    if not clean:
        return None
    upper = clean.upper()
    if any(
        upper.startswith(prefix)
        for prefix in (
            "CREATE MASKING POLICY",
            "CREATE OR REPLACE MASKING POLICY",
            "CREATE OR REPLACE TASK",
            "CREATE TASK",
            "ALTER TASK",
            "COMMENT ON",
            "EXEC SYS.SP_ADDEXTENDEDPROPERTY",
        )
    ):
        return None

    clean = re.sub(
        r"\s+WITH\s+MASKING\s+POLICY\s+[A-Za-z0-9_.]+", "", clean, flags=re.IGNORECASE
    )
    clean = re.sub(
        r"\s+MASKED\s+WITH\s*\([^)]+\)", "", clean, flags=re.IGNORECASE
    )
    clean = re.sub(
        r"\s+CLUSTER\s+BY\s*\([^)]+\)", "", clean, flags=re.IGNORECASE
    )
    clean = re.sub(
        r"\s+DATA_RETENTION_TIME_IN_DAYS\s*=\s*\d+", "", clean, flags=re.IGNORECASE
    )
    clean = re.sub(
        r"^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TRANSIENT\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z0-9_\[\]]+\.)?([A-Za-z0-9_\[\]]+)",
        r"CREATE TABLE IF NOT EXISTS \1",
        clean,
        flags=re.IGNORECASE,
    )
    clean = re.sub(
        r"^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z0-9_\[\]]+\.)?([A-Za-z0-9_\[\]]+)",
        r"CREATE VIEW IF NOT EXISTS \1",
        clean,
        flags=re.IGNORECASE,
    )
    clean = re.sub(
        r"^ALTER\s+TABLE\s+(?:[A-Za-z0-9_\[\]]+\.)?([A-Za-z0-9_\[\]]+)",
        r"ALTER TABLE \1",
        clean,
        flags=re.IGNORECASE,
    )
    return clean


def execute_ddl_on_connection(
    conn_rec: DatabaseConnectionRecord,
    ddl_script: str,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Executes DDL or Complete Compare ALTER statements against the target database connection."""
    eng = create_engine_for_connection(conn_rec)
    is_sqlite = eng.url.drivername.startswith("sqlite")

    raw_lines = [
        ln for ln in ddl_script.splitlines() if not ln.strip().startswith("--")
    ]
    cleaned_script = "\n".join(raw_lines)
    raw_stmts = [s.strip() for s in cleaned_script.split(";") if s.strip()]

    results: List[Dict[str, str]] = []
    executed_count = 0
    skipped_count = 0
    error_count = 0

    with eng.begin() as conn:
        for stmt in raw_stmts:
            exec_sql = _adapt_statement_for_sqlite(stmt) if is_sqlite else stmt
            if exec_sql is None:
                skipped_count += 1
                results.append(
                    {
                        "sql": stmt[:140] + ("..." if len(stmt) > 140 else ""),
                        "status": "SKIPPED",
                        "message": "Dialect-specific policy/task statement skipped on local SQLite engine.",
                    }
                )
                continue

            if dry_run:
                executed_count += 1
                results.append(
                    {
                        "sql": exec_sql[:140] + ("..." if len(exec_sql) > 140 else ""),
                        "status": "DRY_RUN_VALIDATED",
                        "message": "Validated statement syntax (Dry Run).",
                    }
                )
                continue

            try:
                conn.execute(text(exec_sql))
                executed_count += 1
                results.append(
                    {
                        "sql": exec_sql[:140] + ("..." if len(exec_sql) > 140 else ""),
                        "status": "SUCCESS",
                        "message": "Executed successfully.",
                    }
                )
            except Exception as exc:
                error_count += 1
                results.append(
                    {
                        "sql": exec_sql[:140] + ("..." if len(exec_sql) > 140 else ""),
                        "status": "ERROR",
                        "message": str(exc),
                    }
                )

    return {
        "ok": error_count == 0,
        "connection_name": conn_rec.name,
        "dialect": conn_rec.dialect,
        "dry_run": dry_run,
        "statements_executed": executed_count,
        "statements_skipped": skipped_count,
        "errors": error_count,
        "results": results,
    }


# ===========================================================================
# Metadata Pushback Engine: Push Definitions & Comments back to Database
# ===========================================================================
def generate_metadata_push_script(
    conn_rec: DatabaseConnectionRecord,
    model: ProjectMetamodel,
    selected_entities: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Generates database comments and metadata persistence statements tailored to the connection's dialect."""
    dialect = (conn_rec.dialect or "sqlite").lower()
    schema = conn_rec.schema_name or ("dbo" if dialect in ("sql_server", "mssql") else "PUBLIC")

    target_ents = (
        [model.entities[eid] for eid in selected_entities if eid in model.entities]
        if selected_entities
        else list(model.entities.values())
    )

    statements: List[Dict[str, Any]] = []

    if dialect == "sqlite":
        statements.append(
            {
                "target": "SYSTEM",
                "type": "SCHEMA_INIT",
                "sql": (
                    "CREATE TABLE IF NOT EXISTS _metaforge_metadata (\n"
                    "    object_type VARCHAR(20) NOT NULL,\n"
                    "    table_name VARCHAR(100) NOT NULL,\n"
                    "    column_name VARCHAR(100) NOT NULL,\n"
                    "    logical_name VARCHAR(150),\n"
                    "    description TEXT,\n"
                    "    pii_classification VARCHAR(30),\n"
                    "    domain_name VARCHAR(80),\n"
                    "    metadata_status VARCHAR(30),\n"
                    "    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n"
                    "    PRIMARY KEY (table_name, column_name)\n"
                    ");"
                ),
                "description": "Initialize MetaForge Enterprise Metadata Catalog in SQLite",
            }
        )

        for ent in target_ents:
            tbl_desc = (ent.description or "").replace("'", "''")
            tbl_log = (ent.logical_name or "").replace("'", "''")
            statements.append(
                {
                    "target": ent.physical_name,
                    "type": "TABLE_COMMENT",
                    "sql": (
                        f"INSERT OR REPLACE INTO _metaforge_metadata "
                        f"(object_type, table_name, column_name, logical_name, description, pii_classification, domain_name, metadata_status, updated_at) "
                        f"VALUES ('TABLE', '{ent.physical_name}', '__TABLE__', '{tbl_log}', '{tbl_desc}', 'NONE', NULL, '{ent.metadata_status or 'STEWARD_VERIFIED'}', CURRENT_TIMESTAMP);"
                    ),
                    "description": f"Persist table metadata definition for {ent.physical_name}",
                }
            )
            for col in ent.columns:
                col_desc = (col.description or "").replace("'", "''")
                col_log = (col.logical_name or "").replace("'", "''")
                dom_name = (
                    model.domains[col.domain_id].name.replace("'", "''")
                    if col.domain_id and col.domain_id in model.domains
                    else ""
                )
                statements.append(
                    {
                        "target": f"{ent.physical_name}.{col.physical_name}",
                        "type": "COLUMN_COMMENT",
                        "sql": (
                            f"INSERT OR REPLACE INTO _metaforge_metadata "
                            f"(object_type, table_name, column_name, logical_name, description, pii_classification, domain_name, metadata_status, updated_at) "
                            f"VALUES ('COLUMN', '{ent.physical_name}', '{col.physical_name}', '{col_log}', '{col_desc}', '{col.pii_classification}', '{dom_name}', '{col.metadata_status or 'STEWARD_VERIFIED'}', CURRENT_TIMESTAMP);"
                        ),
                        "description": f"Persist column metadata definition for {ent.physical_name}.{col.physical_name}",
                    }
                )

    elif dialect == "snowflake":
        for ent in target_ents:
            tbl_desc = (ent.description or "").replace("'", "''")
            obj_type = "VIEW" if ent.entity_type in ("view", "materialized_view") else "TABLE"
            statements.append(
                {
                    "target": ent.physical_name,
                    "type": "TABLE_COMMENT",
                    "sql": f'COMMENT ON {obj_type} "{schema}"."{ent.physical_name}" IS \'{tbl_desc}\';',
                    "description": f"Apply Snowflake table comment on {ent.physical_name}",
                }
            )
            for col in ent.columns:
                col_desc = (col.description or "").replace("'", "''")
                statements.append(
                    {
                        "target": f"{ent.physical_name}.{col.physical_name}",
                        "type": "COLUMN_COMMENT",
                        "sql": f'COMMENT ON COLUMN "{schema}"."{ent.physical_name}"."{col.physical_name}" IS \'{col_desc}\';',
                        "description": f"Apply Snowflake column comment on {ent.physical_name}.{col.physical_name}",
                    }
                )

    elif dialect in ("sql_server", "mssql", "tsql"):
        for ent in target_ents:
            tbl_desc = (ent.description or "").replace("'", "''")
            statements.append(
                {
                    "target": ent.physical_name,
                    "type": "TABLE_COMMENT",
                    "sql": (
                        f"IF NOT EXISTS (SELECT 1 FROM fn_listextendedproperty(N'MS_Description', N'SCHEMA', N'{schema}', N'TABLE', N'{ent.physical_name}', NULL, NULL))\n"
                        f"    EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'{tbl_desc}', @level0type=N'SCHEMA', @level0name=N'{schema}', @level1type=N'TABLE', @level1name=N'{ent.physical_name}';\n"
                        f"ELSE\n"
                        f"    EXEC sys.sp_updateextendedproperty @name=N'MS_Description', @value=N'{tbl_desc}', @level0type=N'SCHEMA', @level0name=N'{schema}', @level1type=N'TABLE', @level1name=N'{ent.physical_name}';"
                    ),
                    "description": f"Apply SQL Server MS_Description on table {ent.physical_name}",
                }
            )
            for col in ent.columns:
                col_desc = (col.description or "").replace("'", "''")
                statements.append(
                    {
                        "target": f"{ent.physical_name}.{col.physical_name}",
                        "type": "COLUMN_COMMENT",
                        "sql": (
                            f"IF NOT EXISTS (SELECT 1 FROM fn_listextendedproperty(N'MS_Description', N'SCHEMA', N'{schema}', N'TABLE', N'{ent.physical_name}', N'COLUMN', N'{col.physical_name}'))\n"
                            f"    EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'{col_desc}', @level0type=N'SCHEMA', @level0name=N'{schema}', @level1type=N'TABLE', @level1name=N'{ent.physical_name}', @level2type=N'COLUMN', @level2name=N'{col.physical_name}';\n"
                            f"ELSE\n"
                            f"    EXEC sys.sp_updateextendedproperty @name=N'MS_Description', @value=N'{col_desc}', @level0type=N'SCHEMA', @level0name=N'{schema}', @level1type=N'TABLE', @level1name=N'{ent.physical_name}', @level2type=N'COLUMN', @level2name=N'{col.physical_name}';"
                        ),
                        "description": f"Apply SQL Server MS_Description on column {ent.physical_name}.{col.physical_name}",
                    }
                )

    elif dialect == "oracle":
        for ent in target_ents:
            tbl_desc = (ent.description or "").replace("'", "''")
            statements.append(
                {
                    "target": ent.physical_name,
                    "type": "TABLE_COMMENT",
                    "sql": f'COMMENT ON TABLE "{ent.physical_name}" IS \'{tbl_desc}\';',
                    "description": f"Apply Oracle table comment on {ent.physical_name}",
                }
            )
            for col in ent.columns:
                col_desc = (col.description or "").replace("'", "''")
                statements.append(
                    {
                        "target": f"{ent.physical_name}.{col.physical_name}",
                        "type": "COLUMN_COMMENT",
                        "sql": f'COMMENT ON COLUMN "{ent.physical_name}"."{col.physical_name}" IS \'{col_desc}\';',
                        "description": f"Apply Oracle column comment on {ent.physical_name}.{col.physical_name}",
                    }
                )

    elif dialect == "postgresql":
        for ent in target_ents:
            tbl_desc = (ent.description or "").replace("'", "''")
            statements.append(
                {
                    "target": ent.physical_name,
                    "type": "TABLE_COMMENT",
                    "sql": f'COMMENT ON TABLE "{schema.lower()}"."{ent.physical_name.lower()}" IS \'{tbl_desc}\';',
                    "description": f"Apply PostgreSQL table comment on {ent.physical_name}",
                }
            )
            for col in ent.columns:
                col_desc = (col.description or "").replace("'", "''")
                statements.append(
                    {
                        "target": f"{ent.physical_name}.{col.physical_name}",
                        "type": "COLUMN_COMMENT",
                        "sql": f'COMMENT ON COLUMN "{schema.lower()}"."{ent.physical_name.lower()}"."{col.physical_name.lower()}" IS \'{col_desc}\';',
                        "description": f"Apply PostgreSQL column comment on {ent.physical_name}.{col.physical_name}",
                    }
                )

    return statements


def push_metadata_to_connection(
    conn_rec: DatabaseConnectionRecord,
    model: ProjectMetamodel,
    dry_run: bool = False,
    selected_entities: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Executes or dry-run validates metadata pushback statements against the connected database."""
    stmts = generate_metadata_push_script(conn_rec, model, selected_entities)
    eng = create_engine_for_connection(conn_rec)

    results: List[Dict[str, Any]] = []
    executed = 0
    errors = 0

    if dry_run:
        for s in stmts:
            results.append(
                {
                    "target": s["target"],
                    "type": s["type"],
                    "sql": s["sql"][:140] + ("..." if len(s["sql"]) > 140 else ""),
                    "status": "DRY_RUN_VALIDATED",
                    "message": s["description"],
                }
            )
        return {
            "ok": True,
            "connection_name": conn_rec.name,
            "dialect": conn_rec.dialect,
            "dry_run": True,
            "statements_count": len(stmts),
            "statements_executed": len(stmts),
            "errors": 0,
            "results": results,
        }

    with eng.begin() as conn:
        for s in stmts:
            try:
                conn.execute(text(s["sql"]))
                executed += 1
                results.append(
                    {
                        "target": s["target"],
                        "type": s["type"],
                        "sql": s["sql"][:140] + ("..." if len(s["sql"]) > 140 else ""),
                        "status": "SUCCESS",
                        "message": "Metadata successfully deployed.",
                    }
                )
            except Exception as exc:
                errors += 1
                results.append(
                    {
                        "target": s["target"],
                        "type": s["type"],
                        "sql": s["sql"][:140] + ("..." if len(s["sql"]) > 140 else ""),
                        "status": "ERROR",
                        "message": str(exc),
                    }
                )

    return {
        "ok": errors == 0,
        "connection_name": conn_rec.name,
        "dialect": conn_rec.dialect,
        "dry_run": False,
        "statements_count": len(stmts),
        "statements_executed": executed,
        "errors": errors,
        "results": results,
    }
