//! A small HTTP seam, so pricing and quota code is tested against scripted responses.

use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
}

impl Request {
    pub fn get(url: impl Into<String>, timeout: Duration) -> Self {
        Self { method: "GET", url: url.into(), headers: Vec::new(), body: None, timeout }
    }

    #[must_use]
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    /// Header names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A transport failure: no response arrived.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct HttpError(pub String);

pub trait HttpClient: Send + Sync {
    fn send(&self, request: &Request) -> Result<Response, HttpError>;
}

/// `ureq` over rustls, verifying with the platform's trust store.
pub struct UreqClient {
    agent: ureq::Agent,
}

impl Default for UreqClient {
    fn default() -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .user_agent(format!("aitrack/{}", crate::VERSION))
            .tls_config(ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build())
            .build();
        Self { agent: config.new_agent() }
    }
}

impl HttpClient for UreqClient {
    fn send(&self, request: &Request) -> Result<Response, HttpError> {
        let to_error = |error: ureq::Error| HttpError(error.to_string());
        let mut builder = ureq::http::Request::builder().method(request.method).uri(&request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let http_request =
            builder.body(request.body.clone().unwrap_or_default()).map_err(|e| HttpError(e.to_string()))?;
        let http_request = self.agent.configure_request(http_request).timeout_global(Some(request.timeout)).build();
        let mut response = self.agent.run(http_request).map_err(to_error)?;
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| (name.as_str().to_ascii_lowercase(), value.to_str().unwrap_or_default().to_owned()))
            .collect();
        let status = response.status().as_u16();
        let body = response.body_mut().with_config().limit(256 * 1024 * 1024).read_to_vec().map_err(to_error)?;
        Ok(Response { status, headers, body })
    }
}
