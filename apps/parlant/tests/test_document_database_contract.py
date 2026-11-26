"""One contract for PostgresDocumentDatabase, checked against Parlant's own
SQLite adapter as the reference. (Not the transient one: it keeps duplicate ids
on insert and skips document loaders, so it isn't a faithful oracle.) The Postgres runs need a real
server and are skipped unless PARLANT_TEST_DATABASE_URL is set:

    docker run --rm -e POSTGRES_PASSWORD=x -p 5433:5432 postgres:18
    PARLANT_TEST_DATABASE_URL=postgresql://postgres:x@localhost:5433/postgres uv run pytest
"""

import asyncio
import os
from collections.abc import AsyncIterator
from typing import Any, TypedDict
from unittest.mock import MagicMock

import pytest
from parlant.adapters.db.sqlite import SQLiteDocumentDatabase
from parlant.core.loggers import Logger
from parlant.core.persistence.common import ObjectId, SortDirection
from parlant.core.persistence.document_database import BaseDocument, DocumentDatabase

from travel_agent.postgres_db import PostgresDocumentDatabase, ssl_context

PG_URL = os.environ.get("PARLANT_TEST_DATABASE_URL")


class Schema(TypedDict):
    """What every test document has (ensure_is_total checks these keys)."""

    id: ObjectId
    version: str
    creation_utc: str


class Doc(TypedDict, total=False):
    id: ObjectId
    version: str
    creation_utc: str
    session_id: str
    kind: str
    tags: list[str]
    note: str | None
    metadata_revision: int


def doc(i: int, **fields: Any) -> Doc:
    return Doc(
        id=ObjectId(f"d{i}"),
        version="0.1.0",
        creation_utc=f"2026-11-22T00:00:{i:02d}",
        **fields,
    )


async def identity(d: BaseDocument) -> Doc:
    return Doc(**d)  # type: ignore[typeddict-item]


@pytest.fixture(params=["sqlite", "postgres"])
async def database(
    request: pytest.FixtureRequest, tmp_path: Any
) -> AsyncIterator[DocumentDatabase]:
    kind = request.param
    if kind == "sqlite":
        async with SQLiteDocumentDatabase(MagicMock(spec=Logger), tmp_path / "t.db") as db:
            yield db
    else:
        if not PG_URL:
            pytest.skip("PARLANT_TEST_DATABASE_URL is not set")
        async with PostgresDocumentDatabase(PG_URL) as db:
            await db.pool.execute("TRUNCATE parlant_documents, parlant_collections")
            yield db


async def seeded(database: DocumentDatabase):
    c = await database.get_or_create_collection("things", Schema, identity)
    await c.insert_one(doc(1, session_id="s1", kind="a", tags=["x"], note=None))
    await c.insert_one(doc(2, session_id="s1", kind="b", tags=["y"]))
    await c.insert_one(doc(3, session_id="s2", kind="a", tags=["x", "y"], note="hi"))
    return c


async def ids(result: Any) -> list[str]:
    return [str(d["id"]) for d in result]


async def test_collections(database: DocumentDatabase) -> None:
    with pytest.raises(ValueError):
        await database.get_collection("missing", Schema, identity)
    c = await database.get_or_create_collection("things", Schema, identity)
    await c.insert_one(doc(1))
    assert await database.get_or_create_collection("things", Schema, identity) is c
    await database.delete_collection("things")
    with pytest.raises(ValueError):
        await database.delete_collection("things")


async def test_insert_replaces_same_id(database: DocumentDatabase) -> None:
    c = await database.get_or_create_collection("things", Schema, identity)
    await c.insert_one(doc(1, kind="a"))
    await c.insert_one(doc(1, kind="b"))
    assert [d["kind"] for d in await c.find({})] == ["b"]


@pytest.mark.parametrize(
    "filters, expected",
    [
        ({}, ["d1", "d2", "d3"]),
        ({"session_id": {"$eq": "s1"}}, ["d1", "d2"]),
        ({"id": {"$eq": "d2"}, "session_id": {"$eq": "s1"}}, ["d2"]),
        ({"id": {"$eq": "d2"}, "session_id": {"$eq": "s2"}}, []),
        ({"$and": [{"session_id": {"$eq": "s1"}}, {"kind": {"$eq": "a"}}]}, ["d1"]),
        ({"$or": [{"session_id": {"$eq": "s2"}}, {"kind": {"$eq": "b"}}]}, ["d2", "d3"]),
        ({"kind": {"$ne": "a"}}, ["d2"]),
        ({"kind": {"$in": ["a"]}}, ["d1", "d3"]),
    ],
)
async def test_find_filters(
    database: DocumentDatabase, filters: dict[str, Any], expected: list[str]
) -> None:
    c = await seeded(database)
    assert await ids(await c.find(filters)) == expected


async def test_eq_on_null_list_and_missing_field_match_the_reference(
    database: DocumentDatabase, tmp_path: Any
) -> None:
    # Never pushed down; must behave exactly as Parlant's own adapters do.
    c = await seeded(database)
    results = {}
    for name, filters in {
        "null": {"note": {"$eq": None}},
        "list": {"tags": {"$eq": ["x"]}},
        "missing": {"absent": {"$eq": "v"}},
        "session_null": {"session_id": {"$eq": None}},
    }.items():
        try:
            results[name] = await ids(await c.find(filters))  # type: ignore[arg-type]
        except Exception as e:  # noqa: BLE001 - recorded, compared below
            results[name] = type(e).__name__
    reference = {}
    async with SQLiteDocumentDatabase(MagicMock(spec=Logger), tmp_path / "ref.db") as ref:
        rc = await seeded(ref)
        for name, filters in {
            "null": {"note": {"$eq": None}},
            "list": {"tags": {"$eq": ["x"]}},
            "missing": {"absent": {"$eq": "v"}},
            "session_null": {"session_id": {"$eq": None}},
        }.items():
            try:
                reference[name] = await ids(await rc.find(filters))  # type: ignore[arg-type]
            except Exception as e:  # noqa: BLE001
                reference[name] = type(e).__name__
    assert results == reference


async def test_sort_limit_and_cursor_paging(database: DocumentDatabase) -> None:
    c = await seeded(database)
    page = await c.find({}, limit=2, sort_direction=SortDirection.DESC)
    assert await ids(page) == ["d3", "d2"]
    assert page.total_count == 3 and page.has_more and page.next_cursor
    rest = await c.find({}, limit=2, cursor=page.next_cursor, sort_direction=SortDirection.DESC)
    assert await ids(rest) == ["d1"] and not rest.has_more
    assert await ids(await c.find({}, sort_direction=SortDirection.ASC)) == ["d1", "d2", "d3"]
    first = await c.find_one({}, sort=[("kind", SortDirection.DESC), ("id", SortDirection.ASC)])
    assert first and first["id"] == "d2"


async def test_update_and_upsert(database: DocumentDatabase) -> None:
    c = await seeded(database)
    result = await c.update_one({"id": {"$eq": "d1"}}, Doc(kind="z"))
    assert result.matched_count == 1 and result.updated_document
    assert result.updated_document["kind"] == "z"
    assert result.updated_document["session_id"] == "s1"
    missing = await c.update_one({"id": {"$eq": "nope"}}, doc(9, kind="n"))
    assert missing.matched_count == 0 and missing.updated_document is None
    upserted = await c.update_one({"id": {"$eq": "d9"}}, doc(9, kind="n"), upsert=True)
    assert upserted.updated_document and (await c.find_one({"id": {"$eq": "d9"}}))


async def test_metadata_revision_compare_and_swap(database: DocumentDatabase) -> None:
    c = await database.get_or_create_collection("things", Schema, identity)
    await c.insert_one(doc(1, kind="a", metadata_revision=1))
    swap = {"id": {"$eq": "d1"}, "metadata_revision": {"$eq": 1}}
    results = await asyncio.gather(
        c.update_one(swap, Doc(kind="b", metadata_revision=2)),  # type: ignore[arg-type]
        c.update_one(swap, Doc(kind="c", metadata_revision=2)),  # type: ignore[arg-type]
    )
    assert sorted(r.matched_count for r in results) == [0, 1]
    stale = await c.update_one(swap, Doc(kind="d", metadata_revision=3))  # type: ignore[arg-type]
    assert stale.matched_count == 0
    current = await c.find_one({"id": {"$eq": "d1"}})
    assert current and current["metadata_revision"] == 2 and current["kind"] in {"b", "c"}


async def test_delete_one(database: DocumentDatabase) -> None:
    c = await seeded(database)
    deleted = await c.delete_one({"session_id": {"$eq": "s2"}})
    assert deleted.deleted_count == 1 and deleted.deleted_document
    assert (await c.delete_one({"id": {"$eq": "d3"}})).deleted_count == 0
    assert await ids(await c.find({})) == ["d1", "d2"]


async def test_filters_see_documents_after_the_loader(database: DocumentDatabase) -> None:
    # A loader that fills in a field (as CustomerDocumentStore does for `kind`):
    # filtering on that field must find documents stored without it.
    async def add_kind(d: BaseDocument) -> Doc:
        return Doc(**{"kind": "default", **d})  # type: ignore[typeddict-item]

    c = await database.get_or_create_collection("loaded", Schema, add_kind)
    await c.insert_one(doc(1, session_id="s1"))
    assert await ids(await c.find({"kind": {"$eq": "default"}})) == ["d1"]
    assert await ids(await c.find({"session_id": {"$eq": "s1"}, "kind": {"$eq": "default"}})) == [
        "d1"
    ]


def test_ssl_fails_closed() -> None:
    assert ssl_context("postgresql://u:p@localhost:5433/x", None) is False
    with pytest.raises(ValueError, match="not local"):
        ssl_context("postgresql://u:p@db-rw:5432/parlant", None)
    with pytest.raises(ValueError, match="Remove sslmode"):
        ssl_context("postgresql://u:p@db-rw/parlant?sslmode=require", "/ca.crt")
