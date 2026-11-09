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
load('ext://namespace', 'namespace_create')

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
HOST = read_yaml(HOMELAB_DEV_VALUES)['ingress']['host']

namespace_create(NAMESPACE)

k8s_yaml(helm(
    CHART,
    name='travel-agent',
    namespace=NAMESPACE,
    values=[HOMELAB_VALUES, HOMELAB_DEV_VALUES, CHART + '/values-dev.yaml'],
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

k8s_resource('travel-agent-api', labels=['app'],
             links=[link('https://%s/api/health' % HOST, 'health')])
k8s_resource('travel-agent-web', labels=['app'],
             links=[link('https://%s' % HOST, 'app')])
