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
# (default: inkeep). Only the selected in-cluster agent (Parlant or LangGraph) is
# built and deployed. Changing it while Tilt runs (`tilt args -- --chat-backend=...`)
# redeploys the API and swaps the agent; each agent's volume stays, so its saved
# conversations survive the switch.
#
# Web search is the dev kill switch: `tilt args -- --search-provider=off` makes
# every search return 503, so both agents answer without it (default: tavily).
load('ext://namespace', 'namespace_create')
load('ext://restart_process', 'docker_build_with_restart')

config.define_string('chat-backend', usage='inkeep (default), parlant or langgraph')
config.define_string('search-provider', usage='tavily (default) or off')
CFG = config.parse()
CHAT_BACKEND = CFG.get('chat-backend', 'inkeep')
if CHAT_BACKEND not in ['inkeep', 'parlant', 'langgraph']:
    fail('--chat-backend must be inkeep, parlant or langgraph, not %s' % CHAT_BACKEND)
PARLANT = CHAT_BACKEND == 'parlant'
LANGGRAPH = CHAT_BACKEND == 'langgraph'
SEARCH_PROVIDER = CFG.get('search-provider', 'tavily')
if SEARCH_PROVIDER not in ['tavily', 'off']:
    fail('--search-provider must be tavily or off, not %s' % SEARCH_PROVIDER)

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

namespace_create(NAMESPACE)

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

helm_set = [
    'chat.backend=' + CHAT_BACKEND,
    'parlant.enabled=' + str(PARLANT).lower(),
    'langgraph.enabled=' + str(LANGGRAPH).lower(),
    'parlant.image.repository=' + PARLANT_IMAGE,
    'langgraph.image.repository=' + LANGGRAPH_IMAGE,
    'api.env.SEARCH_PROVIDER=' + SEARCH_PROVIDER,
]
def inkeep_bypass_secret():
    """The homelab Inkeep's run API bypass secret, which the API needs for /api/chat.
    Read from the cluster, since .env holds the local Inkeep's. Never printed."""
    out = local(
        "kubectl -n inkeep get secret inkeep-secrets -o jsonpath='{.data.INKEEP_AGENTS_RUN_API_BYPASS_SECRET}' 2>/dev/null | base64 -d",
        quiet=True, echo_off=True)
    value = str(out).strip()
    if not value:
        warn('No INKEEP_AGENTS_RUN_API_BYPASS_SECRET in inkeep/inkeep-secrets: Inkeep chat will return 503')
    return value

api_secret = dev_secret('travel-agent-api-dev',
                        ['INTAKE_API_TOKEN', 'TAVILY_API_KEY', 'SEARCH_API_TOKEN',
                         'LANGGRAPH_API_TOKEN'],
                        {'INKEEP_AGENTS_RUN_API_BYPASS_SECRET': inkeep_bypass_secret()})
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
# The volumes of agents that aren't selected stay, under infra.
idle_volumes = []
if PARLANT:
    # Port-forwarded so Parlant's REST API and /docs are reachable at localhost:8800.
    k8s_resource('travel-agent-parlant', labels=['app'], port_forwards=8800,
                 objects=owned('travel-agent-parlant:persistentvolumeclaim',
                               parlant_secret and parlant_secret + ':secret'))
else:
    idle_volumes.append('travel-agent-parlant:persistentvolumeclaim')
if LANGGRAPH:
    # Port-forwarded so the LangGraph service is reachable at localhost:8900.
    k8s_resource('travel-agent-langgraph', labels=['app'], port_forwards=8900,
                 objects=owned('travel-agent-langgraph:persistentvolumeclaim',
                               langgraph_secret and langgraph_secret + ':secret'))
else:
    idle_volumes.append('travel-agent-langgraph:persistentvolumeclaim')
k8s_resource(new_name='travel-agent-infra', labels=['infra'],
             objects=['%s:namespace' % NAMESPACE, 'travel-agent:ingress'] + idle_volumes)
