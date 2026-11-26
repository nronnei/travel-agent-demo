"""A Postgres DocumentDatabase for Parlant, so its own session and customer stores
can live in Postgres. Parlant 4.0.5 ships SQLite, MongoDB, S3 and Snowflake
adapters, but no Postgres one.

This is a port of ``parlant/adapters/db/sqlite.py`` to asyncpg, against the public
``parlant.core.persistence`` ABCs only, so it can be reused by other Parlant apps.
It keeps the reference adapter's semantics: documents are filtered and sorted in
Python with Parlant's own ``matches_filters``, after each collection's
``document_loader`` has run. Two differences make it fit a shared server:

- Scalar ``$eq`` filters on fields no loader rewrites (``id`` and ``session_id``
  by default) are pushed down to SQL as JSONB containment, served by a GIN index,
  so reading one session's events doesn't load every event stored. The results
  are always re-checked with ``matches_filters``.
- ``update_one`` with a ``metadata_revision`` filter is a single compare-and-swap
  statement, safe across connections and pods.

The in-process reader/writer lock per collection is kept from the reference
adapter; with more than one Parlant replica only the row-level guarantees hold.

Never logs document contents (they hold guest conversations), only names and ids.
"""

from __future__ import annotations

import json
import logging
import ssl
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, Self, cast, override
from urllib.parse import urlparse

import asyncpg
from parlant.core.async_utils import ReaderWriterLock
from parlant.core.persistence.common import (
    Cursor,
    ObjectId,
    SortDirection,
    Where,
    ensure_is_total,
    matches_filters,
)
from parlant.core.persistence.document_database import (
    BaseDocument,
    CollectionIndex,
    CollectionSort,
    DeleteResult,
    DocumentCollection,
    DocumentDatabase,
    FindResult,
    InsertResult,
    TDocument,
    UpdateResult,
)

logger = logging.getLogger(__name__)

DEFAULT_PUSHDOWN_FIELDS = frozenset({"id", "session_id"})
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

_SCHEMA = """
CREATE TABLE IF NOT EXISTS parlant_collections (name text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS parlant_documents (
    collection_name text NOT NULL,
    id text NOT NULL,
    creation_utc text,
    document jsonb NOT NULL,
    PRIMARY KEY (collection_name, id)
);
CREATE INDEX IF NOT EXISTS parlant_documents_creation_idx
    ON parlant_documents (collection_name, creation_utc, id);
CREATE INDEX IF NOT EXISTS parlant_documents_doc_idx
    ON parlant_documents USING gin (document jsonb_path_ops);
"""


def ssl_context(dsn: str, ca_file: str | None) -> ssl.SSLContext | bool:
    """TLS that fails closed: verify against the CA (host name included) when one
    is given, plain text only to a local database, and refuse anything else.
    asyncpg's default (``prefer``) would encrypt without verifying."""
    parsed = urlparse(dsn)
    if "sslmode" in (parsed.query or ""):
        raise ValueError(
            "Remove sslmode from the database URL: TLS is set by PARLANT_DATABASE_SSL_ROOT_CERT"
        )
    if ca_file:
        context = ssl.create_default_context(cafile=ca_file)
        context.check_hostname = True
        context.verify_mode = ssl.CERT_REQUIRED
        return context
    if parsed.hostname in LOCAL_HOSTS:
        return False
    raise ValueError(
        "PARLANT_DATABASE_SSL_ROOT_CERT is not set, and the database host "
        f"{parsed.hostname} is not local: refusing to connect without verifying TLS"
    )


async def _init_connection(connection: asyncpg.Connection) -> None:
    # Without a codec asyncpg returns jsonb as str.
    await connection.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
    )


class PostgresDocumentDatabase(DocumentDatabase):
    def __init__(
        self,
        dsn: str,
        ssl_root_cert: str | None = None,
        *,
        pushdown_fields: frozenset[str] = DEFAULT_PUSHDOWN_FIELDS,
        max_connections: int = 5,
    ) -> None:
        self._dsn = dsn
        self._ssl = ssl_context(dsn, ssl_root_cert)
        self._pushdown_fields = pushdown_fields
        self._max_connections = max_connections
        self._pool: asyncpg.Pool | None = None
        self._collections: dict[str, PostgresDocumentCollection[BaseDocument]] = {}

    async def __aenter__(self) -> Self:
        self._pool = await asyncpg.create_pool(
            self._dsn,
            min_size=1,
            max_size=self._max_connections,
            ssl=self._ssl,
            init=_init_connection,
        )
        async with self._pool.acquire() as connection:
            await connection.execute(_SCHEMA)
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._pool:
            await self._pool.close()
            self._pool = None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("PostgresDocumentDatabase is not open (use `async with`)")
        return self._pool

    def _collection(
        self,
        name: str,
        schema: type[TDocument],
        document_loader: Callable[[BaseDocument], Awaitable[TDocument | None]] | None,
    ) -> PostgresDocumentCollection[TDocument]:
        collection: PostgresDocumentCollection[TDocument] = PostgresDocumentCollection(
            database=self,
            name=name,
            schema=schema,
            document_loader=document_loader,
            pushdown_fields=self._pushdown_fields,
        )
        self._collections[name] = cast(PostgresDocumentCollection[BaseDocument], collection)
        return collection

    @override
    async def create_collection(
        self,
        name: str,
        schema: type[TDocument],
    ) -> PostgresDocumentCollection[TDocument]:
        async with self.pool.acquire() as connection, connection.transaction():
            await connection.execute(
                "INSERT INTO parlant_collections (name) VALUES ($1) ON CONFLICT DO NOTHING", name
            )
            await connection.execute(
                "DELETE FROM parlant_documents WHERE collection_name = $1", name
            )
        return self._collection(name, schema, None)

    @override
    async def get_collection(
        self,
        name: str,
        schema: type[TDocument],
        document_loader: Callable[[BaseDocument], Awaitable[TDocument | None]],
    ) -> PostgresDocumentCollection[TDocument]:
        if cached := self._collections.get(name):
            return cast(PostgresDocumentCollection[TDocument], cached)
        exists = await self.pool.fetchval("SELECT 1 FROM parlant_collections WHERE name = $1", name)
        if exists is None:
            raise ValueError(f'Collection "{name}" does not exist')
        return self._collection(name, schema, document_loader)

    @override
    async def get_or_create_collection(
        self,
        name: str,
        schema: type[TDocument],
        document_loader: Callable[[BaseDocument], Awaitable[TDocument | None]],
    ) -> PostgresDocumentCollection[TDocument]:
        if cached := self._collections.get(name):
            return cast(PostgresDocumentCollection[TDocument], cached)
        await self.pool.execute(
            "INSERT INTO parlant_collections (name) VALUES ($1) ON CONFLICT DO NOTHING", name
        )
        return self._collection(name, schema, document_loader)

    @override
    async def delete_collection(self, name: str) -> None:
        async with self.pool.acquire() as connection, connection.transaction():
            exists = await connection.fetchval(
                "SELECT 1 FROM parlant_collections WHERE name = $1", name
            )
            if exists is None:
                raise ValueError(f'Collection "{name}" does not exist')
            await connection.execute(
                "DELETE FROM parlant_documents WHERE collection_name = $1", name
            )
            await connection.execute("DELETE FROM parlant_collections WHERE name = $1", name)
        self._collections.pop(name, None)


def _is_scalar(value: Any) -> bool:
    return isinstance(value, (str, bool, int, float))


class PostgresDocumentCollection(DocumentCollection[TDocument]):
    def __init__(
        self,
        database: PostgresDocumentDatabase,
        name: str,
        schema: type[TDocument],
        document_loader: Callable[[BaseDocument], Awaitable[TDocument | None]] | None = None,
        pushdown_fields: frozenset[str] = DEFAULT_PUSHDOWN_FIELDS,
    ) -> None:
        self._database = database
        self._name = name
        self._schema = schema
        self._document_loader = document_loader or self._identity_loader
        self._pushdown_fields = pushdown_fields
        self._lock = ReaderWriterLock()

    async def _identity_loader(self, doc: BaseDocument) -> TDocument:
        return cast(TDocument, doc)

    def _pushdown(self, filters: Where) -> dict[str, Any]:
        """The scalar $eq terms on allowlisted fields, at the top level or in a
        top-level $and, as one JSONB containment value. Anything else (null,
        lists, objects, other operators, other fields) stays in Python."""
        terms: dict[str, Any] = {}

        def collect(where: Mapping[str, Any]) -> None:
            for field, condition in where.items():
                if field == "$and" and isinstance(condition, Sequence):
                    for sub in condition:
                        if isinstance(sub, Mapping):
                            collect(sub)
                    continue
                if field not in self._pushdown_fields or not isinstance(condition, Mapping):
                    continue
                if set(condition.keys()) == {"$eq"} and _is_scalar(condition["$eq"]):
                    value = condition["$eq"]
                    if field in terms and terms[field] != value:
                        terms["\0conflict"] = True  # contradictory: matches nothing
                    terms[field] = value

        collect(cast(Mapping[str, Any], filters))
        return terms

    async def _load(self, filters: Where) -> list[TDocument]:
        """Candidate documents (pushed-down filters applied), after the loader."""
        terms = self._pushdown(filters)
        if terms.pop("\0conflict", False):
            return []
        if terms:
            rows = await self._database.pool.fetch(
                "SELECT document FROM parlant_documents "
                "WHERE collection_name = $1 AND document @> $2::jsonb",
                self._name,
                terms,
            )
        else:
            rows = await self._database.pool.fetch(
                "SELECT document FROM parlant_documents WHERE collection_name = $1",
                self._name,
            )
        documents: list[TDocument] = []
        for row in rows:
            loaded = await self._document_loader(cast(BaseDocument, row["document"]))
            if loaded is not None and matches_filters(filters, loaded):
                documents.append(loaded)
        return documents

    @staticmethod
    def _sort(documents: list[TDocument], direction: SortDirection) -> list[TDocument]:
        return sorted(
            documents,
            key=lambda d: (d.get("creation_utc") or "", d.get("id") or ""),
            reverse=direction == SortDirection.DESC,
        )

    @staticmethod
    def _field_sort(documents: Sequence[TDocument], sort: CollectionSort) -> list[TDocument]:
        docs = list(documents)
        for field_name, direction in reversed(sort):
            docs.sort(
                key=lambda d: cast(Any, d.get(field_name)),
                reverse=direction == SortDirection.DESC,
            )
        return docs

    @staticmethod
    def _after_cursor(
        documents: list[TDocument], cursor: Cursor, direction: SortDirection
    ) -> list[TDocument]:
        result = []
        for doc in documents:
            created = str(doc.get("creation_utc", ""))
            doc_id = str(doc.get("id", ""))
            if direction == SortDirection.DESC:
                if created < cursor.sort_value or (
                    created == cursor.sort_value and doc_id < cursor.id
                ):
                    result.append(doc)
            elif created > cursor.sort_value or (
                created == cursor.sort_value and doc_id > cursor.id
            ):
                result.append(doc)
        return result

    async def _find_one_unlocked(
        self, filters: Where, sort: CollectionSort | None = None
    ) -> TDocument | None:
        documents = await self._load(filters)
        if sort:
            documents = self._field_sort(documents, sort)
        return documents[0] if documents else None

    @override
    async def find(
        self,
        filters: Where,
        limit: int | None = None,
        cursor: Cursor | None = None,
        sort_direction: SortDirection | None = None,
    ) -> FindResult[TDocument]:
        async with self._lock.reader_lock:
            direction = sort_direction or SortDirection.ASC
            documents = self._sort(await self._load(filters), direction)
            total_count = len(documents)
            if cursor:
                documents = self._after_cursor(documents, cursor, direction)
            has_more = False
            next_cursor = None
            if limit is not None and len(documents) > limit:
                has_more = True
                documents = documents[:limit]
                if documents:
                    last = documents[-1]
                    next_cursor = Cursor(
                        sort_value=str(last.get("creation_utc", "")),
                        id=ObjectId(str(last.get("id", ""))),
                    )
            return FindResult(
                items=documents,
                total_count=total_count,
                has_more=has_more,
                next_cursor=next_cursor,
            )

    @override
    async def find_one(
        self, filters: Where, sort: CollectionSort | None = None
    ) -> TDocument | None:
        async with self._lock.reader_lock:
            return await self._find_one_unlocked(filters, sort)

    @override
    async def ensure_indexes(self, indexes: Sequence[CollectionIndex]) -> None:
        # The GIN index serves pushed-down equality; nothing per collection.
        return None

    async def _upsert(self, connection: Any, document: Mapping[str, Any]) -> None:
        await connection.execute(
            "INSERT INTO parlant_documents (collection_name, id, creation_utc, document) "
            "VALUES ($1, $2, $3, $4::jsonb) "
            "ON CONFLICT (collection_name, id) DO UPDATE "
            "SET document = EXCLUDED.document, creation_utc = EXCLUDED.creation_utc",
            self._name,
            str(document["id"]),
            str(document.get("creation_utc", "")),
            dict(document),
        )

    @override
    async def insert_one(self, document: TDocument) -> InsertResult:
        ensure_is_total(document, self._schema)
        async with self._lock.writer_lock:
            await self._upsert(self._database.pool, document)
        return InsertResult(acknowledged=True)

    @override
    async def update_one(
        self,
        filters: Where,
        params: TDocument,
        upsert: bool = False,
    ) -> UpdateResult[TDocument]:
        async with self._lock.writer_lock:
            document = await self._find_one_unlocked(filters)
            if document:
                revision_filter = cast(Mapping[str, Any], filters).get("metadata_revision")
                expected_revision = (
                    revision_filter.get("$eq") if isinstance(revision_filter, Mapping) else None
                )
                if expected_revision is not None:
                    # One statement: the revision check and the patch can't be split
                    # by another connection or pod. Shallow, top-level merge, like
                    # the reference adapter's json_set on $.<key>.
                    status = await self._database.pool.execute(
                        "UPDATE parlant_documents SET document = document || $1::jsonb "
                        "WHERE collection_name = $2 AND id = $3 "
                        "AND document->'metadata_revision' = $4::jsonb",
                        dict(params),
                        self._name,
                        str(document["id"]),
                        expected_revision,
                    )
                    if status.endswith(" 0"):
                        return UpdateResult(
                            acknowledged=True,
                            matched_count=0,
                            modified_count=0,
                            updated_document=None,
                        )
                    updated = await self._find_one_unlocked({"id": {"$eq": document["id"]}})
                else:
                    updated = cast(TDocument, {**document, **params})
                    async with (
                        self._database.pool.acquire() as connection,
                        connection.transaction(),
                    ):
                        await connection.execute(
                            "SELECT 1 FROM parlant_documents "
                            "WHERE collection_name = $1 AND id = $2 FOR UPDATE",
                            self._name,
                            str(document["id"]),
                        )
                        await self._upsert(connection, updated)
                return UpdateResult(
                    acknowledged=True,
                    matched_count=1,
                    modified_count=1,
                    updated_document=cast(TDocument, updated),
                )

        if upsert:
            await self.insert_one(params)
            return UpdateResult(
                acknowledged=True,
                matched_count=0,
                modified_count=0,
                updated_document=params,
            )
        return UpdateResult(
            acknowledged=True, matched_count=0, modified_count=0, updated_document=None
        )

    @override
    async def delete_one(self, filters: Where) -> DeleteResult[TDocument]:
        async with self._lock.writer_lock:
            document = await self._find_one_unlocked(filters)
            if document:
                await self._database.pool.execute(
                    "DELETE FROM parlant_documents WHERE collection_name = $1 AND id = $2",
                    self._name,
                    str(document["id"]),
                )
                return DeleteResult(acknowledged=True, deleted_count=1, deleted_document=document)
        return DeleteResult(acknowledged=True, deleted_count=0, deleted_document=None)
