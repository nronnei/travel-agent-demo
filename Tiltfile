# Dev loop against the homelab cluster: `tilt up`
#
# Images are built from each Dockerfile's `dev` target and pushed to Gitea.
# Source edits are synced into the running pods, where nest/vite/tsc watchers
# pick them up; dependency changes fall back to a full image rebuild.
load('ext://namespace', 'namespace_create')

allow_k8s_contexts('default')

NAMESPACE = 'travel-agent'
CHART = 'deploy/helm/travel-agent'

namespace_create(NAMESPACE)

k8s_yaml(helm(
    CHART,
    name='travel-agent',
    namespace=NAMESPACE,
    values=[CHART + '/values-homelab.yaml', CHART + '/values-dev.yaml'],
))

DEP_FILES = ['package.json', 'package-lock.json', 'tsconfig.base.json', 'packages/shared/package.json']

docker_build(
    'code.home.lab/admin/travel-agent-api',
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
    'code.home.lab/admin/travel-agent-web',
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
             links=[link('https://travel.home.lab/api/health', 'health')])
k8s_resource('travel-agent-web', labels=['app'],
             links=[link('https://travel.home.lab', 'app')])
