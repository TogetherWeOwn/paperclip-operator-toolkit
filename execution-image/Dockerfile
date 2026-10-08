# Source recipe only. Image creation requires separate authorization and verified provenance.
FROM ghcr.io/paperclipai/paperclip@sha256:95cc19e5fdd7804b9fd8699fbe33a7202ae6a26e2b42dc5e6fdf4785f213deed
USER 0:0
COPY native.sources /usr/local/share/execution-image/native.sources
RUN test "$(dpkg --print-architecture)" = amd64 \
    && . /etc/os-release && test "$ID:$VERSION_CODENAME" = debian:trixie \
    && apt-get -o Dir::Etc::sourcelist=/usr/local/share/execution-image/native.sources -o Dir::Etc::sourceparts=- update \
    && apt-get -o Dir::Etc::sourcelist=/usr/local/share/execution-image/native.sources -o Dir::Etc::sourceparts=- install -y --no-install-recommends \
        binutils=2.44-3 \
        gcc=4:14.2.0-1 \
        gcc-14=14.2.0-19 \
        libc6-dev=2.41-12+deb13u4 \
        pkg-config=1.8.1-4 \
        pkgconf=1.8.1-4 \
    && test "$(dpkg-query -W -f='${Version}' binutils)" = "2.44-3" \
    && test "$(dpkg-query -W -f='${Version}' gcc)" = "4:14.2.0-1" \
    && test "$(dpkg-query -W -f='${Version}' gcc-14)" = "14.2.0-19" \
    && test "$(dpkg-query -W -f='${Version}' libc6-dev)" = "2.41-12+deb13u4" \
    && test "$(dpkg-query -W -f='${Version}' pkg-config)" = "1.8.1-4" \
    && test "$(dpkg-query -W -f='${Version}' pkgconf)" = "1.8.1-4" \
    && dpkg-query -W -f='${binary:Package}=${Version}\n' > /usr/local/share/execution-image/installed-packages.txt \
    && rm -rf /var/lib/apt/lists/*
# Preserve root entrypoint initialization; drop privileges only for this build-time check.
RUN gosu 1000:1000 sh -eu -c 'test "$(id -u):$(id -g)" = 1000:1000 \
    && test -x /usr/bin/cc && test -x /usr/bin/gcc \
    && test -x /usr/bin/ld && test -x /usr/bin/ar && test -x /usr/bin/pkg-config \
    && test -r /usr/include/stdio.h \
    && /usr/bin/gcc --version && /usr/bin/ld --version && /usr/bin/pkg-config --version'
