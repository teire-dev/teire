# Sandbox image for Android builds (plan S20.1): the JVM image's JDKs, Maven, Gradle and helpers
# (built from images/jvm as its context, so both share one teire-jvm and one init script), plus the
# Android SDK with its licences accepted. Platforms and build tools a project names that aren't here
# are fetched by the Android Gradle Plugin during the install phase, from dl.google.com.
FROM docker.io/cloudflare/sandbox:1.0.3 AS shim
FROM docker.io/library/eclipse-temurin:17-jdk-noble AS jdk17
FROM docker.io/library/eclipse-temurin:25-jdk-noble AS jdk25

# Temurin 21 is the base; 17 and 25 sit beside it (research jvm.md: one repo can need three JDKs).
# Other versions are fetched from Adoptium during the install phase (teire-jvm).
FROM docker.io/library/eclipse-temurin:21-jdk-noble
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq procps unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=jdk17 /opt/java/openjdk /opt/jdk/17
COPY --from=jdk25 /opt/java/openjdk /opt/jdk/25
RUN ln -s /opt/java/openjdk /opt/jdk/21 && /opt/jdk/17/bin/java -version && /opt/jdk/25/bin/java -version
# Maven 3.9.16 and Gradle 9.8.1 for repos without wrappers, pinned by checksum.
ARG MAVEN_SHA512=831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6
ARG GRADLE_SHA256=dce76f55f8e251a3a1f130eb120f30b3d271de2b76c9b0729d316b5a1b6dc01f
RUN curl -fsSL -o /tmp/maven.tgz https://repo1.maven.org/maven2/org/apache/maven/apache-maven/3.9.16/apache-maven-3.9.16-bin.tar.gz \
  && echo "${MAVEN_SHA512}  /tmp/maven.tgz" | sha512sum -c - \
  && tar -xzf /tmp/maven.tgz -C /opt && ln -s /opt/apache-maven-3.9.16/bin/mvn /usr/local/bin/mvn \
  && curl -fsSL -o /tmp/gradle.zip https://services.gradle.org/distributions/gradle-9.8.1-bin.zip \
  && echo "${GRADLE_SHA256}  /tmp/gradle.zip" | sha256sum -c - \
  && unzip -q /tmp/gradle.zip -d /opt && ln -s /opt/gradle-9.8.1/bin/gradle /usr/local/bin/gradle \
  && rm /tmp/maven.tgz /tmp/gradle.zip
# Android command-line tools 23.0 (pinned by checksum; Google's repository lists sha1 e025545c…),
# the licences accepted, and the platforms and build tools current projects compile against.
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
ARG CMDLINE_TOOLS_SHA256=0877a1d048fe4a24efe2eff536ca4223f7adeb58648bb81909d33c446918cfa8
RUN curl -fsSL -o /tmp/cmdline.zip https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip \
  && echo "${CMDLINE_TOOLS_SHA256}  /tmp/cmdline.zip" | sha256sum -c - \
  && mkdir -p "$ANDROID_HOME/cmdline-tools" && unzip -q /tmp/cmdline.zip -d "$ANDROID_HOME/cmdline-tools" \
  && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" && rm /tmp/cmdline.zip \
  && yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null \
  && "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "platform-tools" \
       "platforms;android-36" "platforms;android-35" "build-tools;36.0.0" "build-tools;35.0.0" >/dev/null \
  && chmod -R a+rX "$ANDROID_HOME"
ENV PATH="/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}"
COPY teire.init.gradle TeireRefs.java /usr/local/share/teire/
# Maven Central answers 403 to the sandbox's Cloudflare egress; Google's mirror of it does not.
COPY settings.xml /root/.m2/settings.xml
COPY teire-job teire-job-status teire-jvm /usr/local/bin/
# The check phase runs as this user, as CI runs a repository's tests (not as root); the install
# phase runs as root with HOME=/home/teire, so the caches it fills are the ones the checks read.
RUN useradd -m -u 10001 -s /bin/bash teire
# Gradle and the Android plugin keep their per-user state here during the checks.
ENV ANDROID_USER_HOME=/home/teire/.android
COPY settings.xml /home/teire/.m2/settings.xml
WORKDIR /work
CMD ["sleep", "infinity"]
