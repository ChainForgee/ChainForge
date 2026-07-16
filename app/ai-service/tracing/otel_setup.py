import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.resources import Resource

# Global variables to track state
_in_memory_exporter = None
_initialized = False

def setup_tracing():
    global _in_memory_exporter, _initialized
    if _initialized:
        return
    
    resource = Resource.create(attributes={
        "service.name": "ai-service"
    })
    
    provider = TracerProvider(resource=resource)
    trace.set_tracer_provider(provider)
    
    otel_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    app_env = os.environ.get("APP_ENV", "development")
    
    # In tests, prioritize InMemorySpanExporter so we can assert on spans
    if app_env == "test":
        _in_memory_exporter = InMemorySpanExporter()
        # Use SimpleSpanProcessor for synchronous span processing in tests
        provider.add_span_processor(SimpleSpanProcessor(_in_memory_exporter))
    elif otel_endpoint:
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            exporter = OTLPSpanExporter(endpoint=otel_endpoint)
            # BatchSpanProcessor is standard for production OTLP exporting
            provider.add_span_processor(BatchSpanProcessor(exporter))
        except Exception as e:
            # Fallback to in-memory if OTLP setup fails
            import logging
            logging.getLogger(__name__).warning("Failed to initialize OTLPSpanExporter: %s. Falling back to InMemorySpanExporter.", e)
            _in_memory_exporter = InMemorySpanExporter()
            provider.add_span_processor(SimpleSpanProcessor(_in_memory_exporter))
    else:
        # Default fallback (e.g. development without Jaeger)
        _in_memory_exporter = InMemorySpanExporter()
        provider.add_span_processor(SimpleSpanProcessor(_in_memory_exporter))
        
    _initialized = True

def get_tracer():
    if not _initialized:
        setup_tracing()
    return trace.get_tracer("ai-service")

def get_in_memory_exporter():
    return _in_memory_exporter

# Reset tracing state (mainly for clean unit testing)
def reset_tracing_for_test():
    global _in_memory_exporter, _initialized
    _in_memory_exporter = None
    _initialized = False
    setup_tracing()
