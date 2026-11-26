"""Parlant's own session and customer stores on PostgresDocumentDatabase, the way
main.py wires them. Opt-in on PARLANT_TEST_DATABASE_URL (see
test_document_database_contract.py)."""

import os

import pytest
from parlant.core.agents import AgentId
from parlant.core.common import IdGenerator
from parlant.core.customers import CustomerDocumentStore, CustomerId
from parlant.core.sessions import EventKind, EventSource, SessionDocumentStore

from travel_agent.postgres_db import PostgresDocumentDatabase

PG_URL = os.environ.get("PARLANT_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not PG_URL, reason="PARLANT_TEST_DATABASE_URL is not set")


async def test_sessions_events_and_customers_survive_reopening() -> None:
    assert PG_URL
    async with PostgresDocumentDatabase(PG_URL) as db:
        await db.pool.execute("TRUNCATE parlant_documents, parlant_collections")
        async with (
            CustomerDocumentStore(IdGenerator(), db, collections_prefix="customers") as customers,
            SessionDocumentStore(db, collections_prefix="sessions") as sessions,
        ):
            customer = await customers.create_customer(name="chat1", id=CustomerId("chat1"))
            session = await sessions.create_session(customer.id, AgentId("travel-agent"))
            other = await sessions.create_session(customer.id, AgentId("travel-agent"))
            for text in ["Lisbon", "in April"]:
                await sessions.create_event(
                    session.id, EventSource.CUSTOMER, EventKind.MESSAGE, "t", {"message": text}
                )
            await sessions.create_event(
                other.id, EventSource.CUSTOMER, EventKind.MESSAGE, "t", {"message": "elsewhere"}
            )

    # A restarted Parlant: new pool, new stores, same database.
    async with PostgresDocumentDatabase(PG_URL) as db:
        async with (
            CustomerDocumentStore(IdGenerator(), db, collections_prefix="customers") as customers,
            SessionDocumentStore(db, collections_prefix="sessions") as sessions,
        ):
            assert (await customers.read_customer(CustomerId("chat1"))).name == "chat1"
            events = await sessions.list_events(session.id)
            assert [e.data["message"] for e in events] == ["Lisbon", "in April"]  # type: ignore[index]
            assert [e.offset for e in events] == [0, 1]
            assert (await sessions.read_session(session.id)).customer_id == "chat1"
        names = {r["name"] for r in await db.pool.fetch("SELECT name FROM parlant_collections")}
        assert {n.split("_")[0] for n in names} == {"customers", "sessions"}
