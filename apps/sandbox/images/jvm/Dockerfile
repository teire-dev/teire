# Sandbox image for Java and Kotlin verification (plan S08). Maven, Gradle and their plugins, build
# scripts (programs) and the repo's tests run here, never on the worker.
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
COPY teire.init.gradle /usr/local/share/teire/teire.init.gradle
COPY teire-job teire-job-status teire-jvm /usr/local/bin/
WORKDIR /work
CMD ["sleep", "infinity"]
