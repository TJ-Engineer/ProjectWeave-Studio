use std::process::ExitCode;

use openrm_api::{config::Config, connect, migrate};

#[tokio::main]
async fn main() -> ExitCode {
    dotenvy::dotenv().ok();
    match run().await {
        Ok(()) => {
            println!("OpenRM database migrations are current");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("migration failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let db = connect(&config).await?;
    migrate(&db).await?;
    Ok(())
}
