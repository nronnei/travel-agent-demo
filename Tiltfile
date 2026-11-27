# Dev loop against the homelab cluster: `tilt up`
#
# Images are built from each Dockerfile's `dev` target and pushed to Gitea.
# Source edits are synced into the running pods, where nest/vite/tsc watchers
# pick them up; dependency changes fall back to a full image rebuild.
#
# Cluster-specific settings (image repositories, ingress host, TLS, node
# placement) come from the homelab repo's helm-values/travel-agent.yaml and
# travel-agent-dev.yaml. Set HOMELAB_DIR if it isn't at ../../homelab.
#
# Dev runs in its own namespace, so `tilt up`/`tilt down` never touch the
# release deployment (`npm run deploy`) in the travel-agent namespace.
#
# Pick the agent backend with `tilt up -- --chat-backend=parlant|langgraph`
# (default: inkeep). Only the selected agent is built or deployed: Inkeep runs from
# its published images, in this namespace, with its own databases in the dev cluster. Changing it while Tilt runs (`tilt args -- --chat-backend=...`)
# redeploys the API and swaps the agent; each agent's volume stays, so its saved
# conversations survive the switch.
#
# Web search is the dev kill switch: `tilt args -- --search-provider=off` makes
# every search return 503, so both agents answer without it (default: tavily).
#
# OpenTelemetry export to the homelab Alloy is on by default, labelled
# service.namespace=travel-agent-dev; turn it off with `--otel=off`.
load('ext://namespace', 'namespace_create')
load('ext://restart_process', 'docker_build_with_restart')

config.define_string('chat-backend', usage='inkeep (default), parlant or langgraph')
config.define_string('search-provider', usage='tavily (default) or off')
config.define_string('otel', usage='on (default) or off: OpenTelemetry export to the homelab Alloy')
CFG = config.parse()
CHAT_BACKEND = CFG.get('chat-backend', 'inkeep')
if CHAT_BACKEND not in ['inkeep', 'parlant', 'langgraph']:
    fail('--chat-backend must be inkeep, parlant or langgraph, not %s' % CHAT_BACKEND)
INKEEP = CHAT_BACKEND == 'inkeep'
PARLANT = CHAT_BACKEND == 'parlant'
LANGGRAPH = CHAT_BACKEND == 'langgraph'
SEARCH_PROVIDER = CFG.get('search-provider', 'tavily')
if SEARCH_PROVIDER not in ['tavily', 'off']:
    fail('--search-provider must be tavily or off, not %s' % SEARCH_PROVIDER)
OTEL = CFG.get('otel', 'on')
if OTEL not in ['on', 'off']:
    fail('--otel must be on or off, not %s' % OTEL)
OTEL_ENDPOINT = 'http://alloy.monitoring.svc.cluster.local:4318'

allow_k8s_contexts('default')

NAMESPACE = 'travel-agent-dev'
CHART = 'deploy/helm/travel-agent'

HOMELAB_DIR = os.getenv('HOMELAB_DIR', os.path.abspath('../../homelab'))
HOMELAB_VALUES = os.path.join(HOMELAB_DIR, 'helm-values', 'travel-agent.yaml')
HOMELAB_DEV_VALUES = os.path.join(HOMELAB_DIR, 'helm-values', 'travel-agent-dev.yaml')
for f in [HOMELAB_VALUES, HOMELAB_DEV_VALUES]:
    if not os.path.exists(f):
        fail('Missing %s. Clone the homelab repo or set HOMELAB_DIR.' % f)

cluster = read_yaml(HOMELAB_VALUES)
# The homelab values don't set a Parlant image yet; push it next to the api's.
PARLANT_IMAGE = cluster.get('parlant', {}).get('image', {}).get('repository') or \
    cluster['api']['image']['repository'].replace('travel-agent-api', 'travel-agent-parlant')
LANGGRAPH_IMAGE = cluster.get('langgraph', {}).get('image', {}).get('repository') or \
    cluster['api']['image']['repository'].replace('travel-agent-api', 'travel-agent-langgraph')
HOST = read_yaml(HOMELAB_DEV_VALUES)['ingress']['host']
# Whether the homelab values turn on the Postgres PodMonitor (dev inherits it).
PODMONITOR = cluster.get('postgres', {}).get('podMonitor', {}).get('enabled', False)

namespace_create(NAMESPACE)

# Tilt only manages what this run deploys, so a backend selected in an earlier run
# keeps running after a switch. Remove the other backends' workloads (Deployments,
# StatefulSets, Services); their volumes, Secrets and databases stay, so switching
# back picks up where it left off.
BACKEND_COMPONENTS = {
    'inkeep': ['inkeep-api', 'inkeep-ui', 'inkeep-spicedb', 'inkeep-doltgres'],
    'parlant': ['parlant'],
    'langgraph': ['langgraph'],
}
STALE = [c for b, cs in BACKEND_COMPONENTS.items() if b != CHAT_BACKEND for c in cs]
if OTEL != 'on':
    STALE.append('alloy')  # the namespace's collector, when OTEL is off
local(("kubectl -n %s delete deployment,statefulset,service --ignore-not-found --wait=false " +
       "-l 'app.kubernetes.io/instance=travel-agent,app.kubernetes.io/component in (%s)'")
      % (NAMESPACE, ','.join(STALE)), quiet=True)

def read_dotenv(path):
    """KEY=VALUE lines from a .env file (no interpolation), or {} if it's missing."""
    env = {}
    if not os.path.exists(path):
        return env
    for line in str(read_file(path)).splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ['"', "'"]:
            v = v[1:-1]
        env[k.strip()] = v
    return env

# Dev secrets come from the repo's .env (and the cluster's Inkeep, below), even
# when the homelab values name the prod Secrets: dev runs in its own namespace.
# The pods never see .env itself, only these Secrets.
DOTENV = read_dotenv('.env')
watch_file('.env')

def dev_secret(name, keys, extra={}):
    """A Secret in the dev namespace holding these .env keys (plus extra); returns its name, or '' if empty."""
    data = {k: DOTENV[k] for k in keys if DOTENV.get(k)}
    data.update({k: v for k, v in extra.items() if v})
    missing = [k for k in keys if k not in data]
    if missing:
        warn('.env is missing %s for the %s secret' % (', '.join(missing), name))
    if not data:
        return ''
    k8s_yaml(encode_yaml({
        'apiVersion': 'v1',
        'kind': 'Secret',
        'metadata': {'name': name, 'namespace': NAMESPACE},
        'type': 'Opaque',
        'stringData': data,
    }))
    return name

def basic_auth_secret(name, username, key, source=None):
    """A kubernetes.io/basic-auth Secret for a CNPG DatabaseRole, its password from .env
    (or `source`); returns its name, or ''. Applied with kubectl rather than k8s_yaml: Tilt
    scrubs the values of Secrets it deploys from every log, and the usernames ("langgraph",
    "parlant") are everyday words there. Like the cluster, it outlives `tilt down`."""
    password = (source if source != None else DOTENV).get(key)
    if not password:
        warn('.env is missing %s: the %s database role has no password, so %s can\'t connect' % (key, username, username))
        return ''
    local('kubectl -n %s apply -f -' % NAMESPACE, quiet=True, echo_off=True, stdin=encode_yaml({
        'apiVersion': 'v1',
        'kind': 'Secret',
        'metadata': {'name': name, 'namespace': NAMESPACE},
        'type': 'kubernetes.io/basic-auth',
        'stringData': {'username': username, 'password': password},
    }))
    return name

# Dev's own Inkeep (inkeep.server.enabled). Its generated secrets live in the gitignored
# .tilt/inkeep-dev.env, made once and then reused, so sessions and JWTs survive
# restarts. Delete the file (and the Inkeep databases) to start over.
INKEEP_DEV_ENV = '.tilt/inkeep-dev.env'
if not os.path.exists(INKEEP_DEV_ENV):
    local('mkdir -p .tilt && umask 077 && scripts/inkeep-secrets.sh generate > %s' % INKEEP_DEV_ENV,
          quiet=True, echo_off=True)
INKEEP_ENV = read_dotenv(INKEEP_DEV_ENV)

helm_set = [
    'chat.backend=' + CHAT_BACKEND,
    'inkeep.server.enabled=' + str(INKEEP).lower(),
    'parlant.enabled=' + str(PARLANT).lower(),
    'langgraph.enabled=' + str(LANGGRAPH).lower(),
    'parlant.image.repository=' + PARLANT_IMAGE,
    'langgraph.image.repository=' + LANGGRAPH_IMAGE,
    'api.env.SEARCH_PROVIDER=' + SEARCH_PROVIDER,
    # Always set, so the homelab (prod) values never leak prod labels into dev.
    'otel.enabled=' + str(OTEL == 'on').lower(),
    'otel.upstreamEndpoint=' + OTEL_ENDPOINT,
    'otel.environment=dev',
]
api_secret = dev_secret('travel-agent-api-dev',
                        ['INTAKE_API_TOKEN', 'TAVILY_API_KEY', 'SEARCH_API_TOKEN',
                         'LANGGRAPH_API_TOKEN'])
if api_secret:
    helm_set.append('inkeep.existingSecret=' + api_secret)
parlant_secret = PARLANT and dev_secret('travel-agent-parlant-dev',
                                        ['ANTHROPIC_API_KEY', 'VOYAGE_API_KEY',
                                         'INTAKE_API_TOKEN', 'SEARCH_API_TOKEN'])
if parlant_secret:
    helm_set.append('parlant.existingSecret=' + parlant_secret)
# Existing .env files predate LANGGRAPH_API_TOKEN: add it by hand
# (openssl rand -base64 32), or LangGraph chat returns 503 naming it.
langgraph_secret = LANGGRAPH and dev_secret('travel-agent-langgraph-dev',
                                            ['ANTHROPIC_API_KEY', 'INTAKE_API_TOKEN',
                                             'SEARCH_API_TOKEN', 'LANGGRAPH_API_TOKEN'])
if langgraph_secret:
    helm_set.append('langgraph.existingSecret=' + langgraph_secret)
# The in-chart Inkeep's Secret: its generated values plus the keys it shares with the API.
inkeep_secret = INKEEP and dev_secret('travel-agent-inkeep-dev',
                                      ['ANTHROPIC_API_KEY', 'SEARCH_API_TOKEN', 'INTAKE_API_TOKEN'],
                                      {k: v for k, v in INKEEP_ENV.items() if not k.endswith('_DB_PASSWORD')})
if inkeep_secret:
    helm_set.append('inkeep.server.secret=' + inkeep_secret)
# Passwords for the backends' roles in the dev Postgres cluster (values-dev.yaml
# turns both on, whichever backend is selected). Existing .env files predate these
# keys: add them by hand (openssl rand -hex 32).
basic_auth_secret('travel-agent-db-langgraph', 'langgraph', 'LANGGRAPH_DB_PASSWORD')
basic_auth_secret('travel-agent-db-parlant', 'parlant', 'PARLANT_DB_PASSWORD')
basic_auth_secret('travel-agent-db-inkeep', 'inkeep', 'INKEEP_DB_PASSWORD', INKEEP_ENV)
basic_auth_secret('travel-agent-db-spicedb', 'spicedb', 'SPICEDB_DB_PASSWORD', INKEEP_ENV)

k8s_yaml(helm(
    CHART,
    name='travel-agent',
    namespace=NAMESPACE,
    values=[HOMELAB_VALUES, HOMELAB_DEV_VALUES, CHART + '/values-dev.yaml'],
    set=helm_set,
))

DEP_FILES = ['package.json', 'package-lock.json', 'tsconfig.base.json', 'packages/shared/package.json']

docker_build(
    cluster['api']['image']['repository'],
    context='.',
    dockerfile='apps/api/Dockerfile',
    target='dev',
    platform='linux/amd64',
    live_update=[
        fall_back_on(DEP_FILES + ['apps/api/package.json', 'apps/api/tsconfig.json']),
        sync('packages/shared/src', '/repo/packages/shared/src'),
        sync('apps/api/src', '/repo/apps/api/src'),
        # New migrations from `npm run db:generate`, applied when the API restarts.
        sync('apps/api/drizzle', '/repo/apps/api/drizzle'),
    ],
)

docker_build(
    cluster['web']['image']['repository'],
    context='.',
    dockerfile='apps/web/Dockerfile',
    target='dev',
    platform='linux/amd64',
    live_update=[
        fall_back_on(DEP_FILES + ['apps/web/package.json', 'apps/web/vite.config.ts']),
        sync('packages/shared/src', '/repo/packages/shared/src'),
        sync('apps/web/src', '/repo/apps/web/src'),
        sync('apps/web/public', '/repo/apps/web/public'),
        sync('apps/web/index.html', '/repo/apps/web/index.html'),
    ],
)

if PARLANT:
    # Parlant builds its agent at startup, so synced edits restart the process
    # (restart_process works on any container runtime, unlike restart_container).
    # The chart mounts an emptyDir over /tmp, which would hide the default
    # /tmp/.restart-proc watch file, so it lives in /app instead.
    docker_build_with_restart(
        PARLANT_IMAGE,
        context='apps/parlant',
        dockerfile='apps/parlant/Dockerfile',
        target='dev',
        platform='linux/amd64',
        entrypoint=['/app/.venv/bin/python', 'main.py'],
        restart_file='/app/.restart-proc',
        live_update=[
            fall_back_on(['apps/parlant/pyproject.toml', 'apps/parlant/uv.lock']),
            sync('apps/parlant/travel_agent', '/app/travel_agent'),
            sync('apps/parlant/main.py', '/app/main.py'),
        ],
    )

if LANGGRAPH:
    # The LangGraph agent: tsx watch restarts the server when synced source changes.
    docker_build(
        LANGGRAPH_IMAGE,
        context='.',
        dockerfile='apps/langgraph/Dockerfile',
        target='dev',
        platform='linux/amd64',
        live_update=[
            fall_back_on(DEP_FILES + ['apps/langgraph/package.json', 'apps/langgraph/tsconfig.json']),
            sync('packages/shared/src', '/repo/packages/shared/src'),
            sync('apps/langgraph/src', '/repo/apps/langgraph/src'),
        ],
    )

# Each workload owns its Secret and volume; the rest goes under "infra", so
# nothing lands in Tilt's "uncategorized" group.
def owned(*objects):
    return [o for o in objects if o]

k8s_resource('travel-agent-api', labels=['app'],
             objects=owned(api_secret and api_secret + ':secret'),
             links=[link('https://%s/api/health' % HOST, 'health')])
k8s_resource('travel-agent-web', labels=['app'],
             links=[link('https://%s' % HOST, 'app')])
# Each backend's database objects in the shared cluster (its role and database).
def db_objects(component):
    name = 'travel-agent-db-' + component
    return [name + ':databaserole', name + ':database']

# The volumes and databases of agents that aren't selected stay, under infra.
idle_volumes = []
if PARLANT:
    # Port-forwarded so Parlant's REST API and /docs are reachable at localhost:8800.
    k8s_resource('travel-agent-parlant', labels=['app'], port_forwards=8800,
                 objects=owned(parlant_secret and parlant_secret + ':secret') + db_objects('parlant'))
else:
    idle_volumes += db_objects('parlant')
if LANGGRAPH:
    # Port-forwarded so the LangGraph service is reachable at localhost:8900.
    k8s_resource('travel-agent-langgraph', labels=['app'], port_forwards=8900,
                 objects=owned(langgraph_secret and langgraph_secret + ':secret') + db_objects('langgraph'))
else:
    idle_volumes += db_objects('langgraph')
if INKEEP:
    # Its Secret and database objects first: every Inkeep pod needs them at start.
    k8s_resource(new_name='travel-agent-inkeep-config', labels=['inkeep'],
                 objects=owned(inkeep_secret and inkeep_secret + ':secret')
                         + db_objects('inkeep') + db_objects('spicedb'))
    k8s_resource('travel-agent-inkeep-doltgres', labels=['inkeep'],
                 resource_deps=['travel-agent-inkeep-config'])
    k8s_resource('travel-agent-inkeep-spicedb', labels=['inkeep'],
                 resource_deps=['travel-agent-inkeep-config'])
    # Port-forwarded: the manage UI (localhost:3003) talks to the API from the browser
    # (localhost:3002), and the agents are pushed through it.
    k8s_resource('travel-agent-inkeep-api', labels=['inkeep'], port_forwards='3002:3002',
                 resource_deps=['travel-agent-inkeep-spicedb', 'travel-agent-inkeep-doltgres'])
    k8s_resource('travel-agent-inkeep-ui', labels=['inkeep'], port_forwards='3003:3000',
                 links=[link('http://localhost:3003', 'manage UI')],
                 resource_deps=['travel-agent-inkeep-api'])
    # Push the agents once both APIs are up (Inkeep discovers the web_search MCP tool
    # from the travel-agent API on push), and again whenever their source changes.
    local_resource('inkeep-push', labels=['inkeep'],
                   cmd='scripts/push-agents.sh dev',
                   env={'INKEEP_API': 'http://localhost:3002', 'INKEEP_UI': 'http://localhost:3003',
                        'INKEEP_MANAGE_KEY': INKEEP_ENV.get('INKEEP_AGENTS_MANAGE_API_BYPASS_SECRET', '')},
                   deps=['apps/agents/src'],
                   resource_deps=['travel-agent-inkeep-api', 'travel-agent-api'])
else:
    idle_volumes += db_objects('inkeep') + db_objects('spicedb')
if OTEL == 'on':
    # This namespace's own collector: apps export to it, it forwards to the central Alloy.
    k8s_resource('travel-agent-alloy', labels=['infra'], objects=['travel-agent-alloy:configmap'])
k8s_resource(new_name='travel-agent-infra', labels=['infra'],
             objects=['%s:namespace' % NAMESPACE, 'travel-agent:ingress', 'travel-agent-db:cluster']
                     + (['travel-agent-db-metrics:podmonitor'] if PODMONITOR else []) + idle_volumes)
