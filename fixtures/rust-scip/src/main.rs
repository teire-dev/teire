use semver::VersionReq;

fn main() {
    let v = semver::Version::parse("1.2.3").unwrap();
    let req = VersionReq::parse(">=1.0").unwrap();
    println!("{}", req.matches(&v));
}
